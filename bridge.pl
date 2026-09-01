% Purpose: the Prolog half of the Node binding's transport. It runs MeTTa
%   inside an SWI engine that can suspend, so answers arrive one at a time and
%   a host operation written in TypeScript is called from the middle of a
%   reduction; it speaks the tagged codec the other bindings speak; and it
%   carries the space, registration and scope verbs the TypeScript surface
%   rests on.
% Assumes:
%   - every engine predicate called here carries an seam:kind/2 in
%     engine/ext_points.pl, service or host_service, or is a MeTTa builtin that
%     builtin_fun/1 already enumerates [tested: tests/prolog/static_checks.pl,
%     a_host_binding_calls_only_published_surface]
%   - engine_create/3, engine_next/2, engine_post/3, engine_yield/1 and
%     engine_fetch/1 exist in the host SWI, including the WebAssembly build
%     [measured 2026-08-27: swipl-wasm 8.0.6, a goal yielded a host request,
%     the host posted an answer back and the goal resumed with it]
%   - engine_yield/1 may NOT be called from inside transaction/1 or
%     snapshot/1: both open a nested C query frame the yield cannot unwind
%     through, and the attempt raises "No permission to execute vmi I_YIELD"
%     [measured 2026-08-27; it works inside catch/3, once/1, call/1,
%     if-then-else, forall/2, findall/3, aggregate_all/3 and
%     setup_call_cleanup/3]
%   - the transport carries a number as its canonical Prolog text, because
%     the WebAssembly value conversion renders the float 2.0 as the
%     JavaScript number 2, which is also what the integer 2 renders as, and
%     the two are DIFFERENT ATOMS [measured 2026-08-30: (== 2 2.0) and
%     (=alpha 2 2.0) answer false, (case 2 ((2.0 float) ($_ other))) answers
%     other, and (subtraction-atom (2 2.0) (2)) answers (2.0)]. Equality is
%     pure term equality, so a codec has to preserve the constructor identity
%     it observes [source:
%     PeTTa@ae66fa8e41dcd5539d614706bd4e5cfb34f9608d src/metta.pl,
%     eval_20/6 clauses for '==' and '!='].
% Guarantees:
%   - metta_node_step/2 computes at most one event per call, so a host that
%     stops pulling leaves the rest of an infinite stream uncomputed
%     [tested: "leaves an abandoned stream's remaining answers uncomputed"]
%   - a term the codec has no tag for raises rather than crossing as text
%     [tested: "refuses a tag outside the grammar"]
%   - metta_node_stop/1 is idempotent
%     [tested: "closes a cursor that is abandoned before its first pull"]
%   - no Prolog exception reaches the host: every synchronous call arrives
%     through metta_node_do/2 and every job body through metta_node_guarded/2,
%     so the outcome crosses as data
%     [tested: "raises an error rather than printing it"]
%   - a host operation's dispatch clause refuses with its own diagnostic when
%     it is reached outside an engine, rather than with SWI's vmi message
%     [tested: "refuses a host operation reached where the engine cannot
%     suspend"]
%   - signed-i64 Number values and wider BigInt values cross as exact decimal
%     text in both directions
%     [tested: "carries Number and BigInt across the signed-i64 boundary"]
%   - p accepts only an ampersand-prefixed space name, and the reserved engine
%     spaces cross as p rather than collapsing into ordinary symbols
%     [tested: "decodes a portable space reference into an interned handle",
%     "reads a space reference back as an interned handle"]
%   - runnable free variables retain source names in their wire value and host
%     text [tested: "keeps a source variable's own name in the answer and in
%     the text"]
%   - a world's journal removes one matching parent occurrence per entry,
%     including when the entry contains variables [tested: "spends one removal
%     budget for a nonground journal entry"; commit=WORKTREE]
% Owns: one SWI engine per open job, released by metta_node_stop/1, which the
%   JavaScript iterator calls from its own return() so an abandoned for-await
%   releases it; the watch queues; the registered-operation table.
% Decides: a job, a host value and a watch are addressed by INTEGER, because
%   the WebAssembly value conversion renders every Prolog blob as the same
%   opaque {"$t":"b"} and a host that kept the blob could not hand it back.
%   A Prolog integer crosses as decimal text and a float as its ~q spelling.
% Open Obligations:
%   To Do: None
%   Hacks: None
%   Future Enhancements: None

:- dynamic metta_node_job/2.
:- dynamic metta_node_captured/1.
:- dynamic metta_node_op/3.
:- dynamic metta_node_watch/4.
:- dynamic metta_node_event/3.

%%%%%%%%%% Every synchronous call from the host comes through here %%%%%%%%%%
%
% swipl-wasm PRINTS a Prolog exception on the host's console before handing it
% back: its query loop runs `console.error(msg)` or `console.log(msg)` in the
% PL_S_EXCEPTION branch, whichever the query flags select, and offers no way
% to turn it off [source: swipl-wasm 8.0.6, dist/swipl/swipl.js, verified
% 2026-08-20 by intercepting console.log around a refused source]. An
% embedded engine writing over its host's own output is a defect the host
% cannot fix, so no exception crosses the boundary: the outcome is DATA and
% the JavaScript side raises from it.
%
% [ok], [fail] or [error, Text]. A goal that fails rather than raising is a
% bug in this file, not an answer, and the host says so; MeTTa's own "no
% answers" is an empty group, which is a success here.
metta_node_do(Goal, Outcome) :-
    catch(( call(Goal) -> Outcome = [ok] ; Outcome = [fail] ),
          Ball,
          ( metta_node_render(Ball, Text), Outcome = [error, Text] )).

% The message is SWI's own: print_message/2 renders it through exactly the
% machinery the console would have used, and the hook below takes the lines
% instead of letting them out. Only ONE message is emitted inside the guarded
% window, so nothing else is caught by it.
metta_node_render(Ball, Text) :-
    retractall(metta_node_captured(_)),
    setup_call_cleanup(nb_setval('$metta_node_capture', true),
                       catch(print_message(error, Ball), _, true),
                       nb_setval('$metta_node_capture', false)),
    (   metta_node_captured(Rendered)
    ->  Text = Rendered
    ;   term_string(Ball, Text)
    ),
    retractall(metta_node_captured(_)).

% Deaf outside metta_node_render/2, and it has to be: a hook that succeeds
% suppresses the message, so an always-on one would swallow the loader's own
% diagnostics. It is module-qualified because message_hook/3 is SWI's protocol
% and not a seam of this engine's.
:- multifile user:message_hook/3.
user:message_hook(_, _, Lines) :-
    nb_current('$metta_node_capture', true),
    print_message_lines(atom(Text), '', Lines),
    assertz(metta_node_captured(Text)).

%%%%%%%%%% The tagged codec %%%%%%%%%%
%
% The same tags extensions/python/metta/shim.pl's metta_py_encode/2 writes and
% extensions/node/src/wire.ts reads: s symbol, v variable, n number, g string,
% b boolean, e expression, p portable space handle, o live host value.
%
% `o` carries a JavaScript value BY REFERENCE. The engine has no JavaScript
% values, so the honest representation is a handle: the host keeps the object
% in its own table and the engine holds the integer, which is what makes
% handing the reference back reach the very same object. `h`, a native engine
% blob, is refused rather than faked, because its whole point is an identity a
% registry hands back and this binding has no registry for one.
%
% The number payload is TEXT and that is this transport's own decision, not
% the grammar's. Every other payload survives the WebAssembly value
% conversion unchanged; raw swipl-wasm changes from JavaScript Number to
% BigInt at 2^53, while the language changes from Number to BigInt at signed
% i64. Text keeps those independent and preserves the integer/float split.
% The wire is FLAT: one preorder token list per atom, arity-prefixed. A leaf
% is its tag followed by its payload; an expression is `e`, its child COUNT,
% and then its children's tokens in order, so `(f 1)` crosses as
% [e, 2, s, "f", n, "1"] and nothing in the list is itself a list.
%
% That is prefix notation with explicit arity, the shape PL_record_external
% writes for a compound term, and it is used here for one reason. swipl-wasm's
% toJSON recurses once per NESTED element and its toProlog once per nested
% array, so a term N deep costs N JavaScript frames in each direction; a flat
% list of atomic tokens goes through toJSON's PL_LIST_PAIR while-loop and
% toProlog's toList loop at constant depth. It is not a tidiness point:
% measured 2026-08-31, `(f (f ... 1 ...))` 2048 deep raised
% `RangeError: Maximum call stack size exceeded` from INSIDE PL_get_chars, and
% the module context this file's own predicates are called in was lost with
% it -- every later unqualified goal answered `Unknown procedure:
% system:metta_node_do/2` while `user:metta_node_do/2` still ran. A stack
% exhausted inside the WebAssembly call is not recoverable from the host, so
% the crossing must not be able to reach one. Flat, the same term encodes at
% 1,000,000 deep in 655 ms and four million raises a catchable
% resource_error(stack) with the session intact.
%
% The difference list is what keeps the whole encoding linear: appending each
% child's tokens to a list built by maplist would be quadratic in the term.
% A variable's wire name is MINTED and remembered, never read off the stack.
%
% SWI prints an unbound variable as its stack offset:
%
%   if (p > (Word) lBase) iref = ((Word)p - (Word)lBase)*2+1;
%   else                  iref = ((Word)p - (Word)gBase)*2;
%   Ssprintf(name, "_%%" PRIi64, (int64_t)iref);
%
% [source: SWI-Prolog src/pl-write.c, var_name_ptr()]. An offset moves when a
% collection moves the cell and is handed to whatever lands there next, so
% `term_to_atom` broke the contract in both directions. Measured 2026-08-31 in
% this build: one cell held in the database crossed as `_165392`, then as
% `_198` after a collection; and inside ONE encode, `[f, V, <3,000,000 cells>,
% V]` gave `_20612914` for the first occurrence of V and `_70` for the second,
% so one variable arrived on the host as two.
%
% The map is THREADED rather than pre-built, so a ground term pays only for
% passing it and a name is minted the first time a cell is met. The counter is
% gensym's, which this file already uses for cut barriers: within a crossing
% one cell is one name, which is what the MAP gives, and across crossings two
% cells are never one name, which is what the SESSION counter gives. Numbering
% per term would satisfy the first and break the second, since a host atom
% compares by spelling and two answers put in one expression would share a
% variable that was never shared. This is the same fix, with the same
% reasoning, that `extensions/python/metta/shim.pl` carries.
metta_node_encode(T, Wire) :- metta_node_encode(T, [], _, Wire, []).

metta_node_encode(T, N0, N, [v, Name|R], R) :- var(T), !,
    metta_node_wire_name(T, N0, N, Name).
metta_node_encode(T, N, N, [o, Text|R], R) :- metta_node_object_id(T, Id), !,
    number_string(Id, Text).
metta_node_encode(T, N, N, [n, Text|R], R) :- number(T), !, metta_node_number_text(T, Text).
metta_node_encode(T, N, N, [g, T|R], R)    :- string(T), !.
metta_node_encode(T, N, N, [b, T|R], R)    :- ( T == true ; T == false ), !.
metta_node_encode(T, N, N, [p, S|R], R) :- atom(T), metta_space_operand(T), !, atom_string(T, S).
metta_node_encode(T, N, N, [s, S|R], R)    :- atom(T), !, atom_string(T, S).
metta_node_encode(T, N0, N, [e, Count|R0], R)   :- is_list(T), !,
    metta_node_encode_items(T, N0, N, 0, Count, R0, R).
metta_node_encode(T, _, _, _, _) :-
    throw(error(metta_node_untaggable(T),
                context(metta_node_encode/2,
                        'the Node binding has no wire tag for this term'))).

% The count rides an accumulator rather than a length/2 call, and it can,
% because the count's own cell is a HOLE in the difference list until the walk
% that fills it is done. Arithmetic on an integer retires no inference in SWI
% while length/2 retires one per expression [measured 2026-08-31].
metta_node_encode_items([], N, N, C, C, R, R).
metta_node_encode_items([X|Xs], N0, N, C0, C, R0, R) :-
    C1 is C0 + 1,
    metta_node_encode(X, N0, N1, R0, R1),
    metta_node_encode_items(Xs, N1, N, C1, C, R1, R).

% The name this cell already has, or a fresh one. Compared by ==, because the
% identity of a Prolog variable is only answerable by comparison, which is why
% this scan and engine/writer.c's are both linear in the count of DISTINCT
% variables a term holds.
metta_node_wire_name(Variable, Names0, Names, Name) :-
    (   metta_node_var_name(Names0, Variable, Found)
    ->  Names = Names0,
        atom_string(Found, Name)
    ;   metta_node_fresh_name(Names0, Fresh),
        Names = [Fresh-Variable|Names0],
        atom_string(Fresh, Name)
    ).

% Seeded names are stepped over: a caller may seed the map with the reader's
% own spellings, and `$_3` is one a program is allowed to write.
metta_node_fresh_name(Names, Name) :-
    gensym('_', Candidate),
    (   memberchk(Candidate-_, Names)
    ->  metta_node_fresh_name(Names, Name)
    ;   Name = Candidate
    ).

% Encode with an explicit Name-Var list, so parsed variables keep their names.
% The list SEEDS the same map every encode threads, so a variable the seed does
% not name is minted beside the named ones rather than through a second naming
% rule that could disagree with them.
metta_node_encode_named(T, Pairs, Wire) :- metta_node_encode(T, Pairs, _, Wire, []).

metta_node_encode_with_names(Pairs, Term, Encoded) :-
    metta_node_encode_named(Term, Pairs, Encoded).

% Every argument of ONE call under ONE map, and the map itself, because the
% reply is decoded against it: a variable the host hands back is the caller's
% variable, and a variable in two arguments is one variable.
metta_node_encode_arguments([], N, N, []).
metta_node_encode_arguments([A|As], N0, N, [W|Ws]) :-
    metta_node_encode(A, N0, N1, W, []),
    metta_node_encode_arguments(As, N1, N, Ws).

% One expression wire from child wires that are already flat, for the rows
% this file builds by hand rather than by encoding a term.
metta_node_expr_wire(Children, [e, N|Flat]) :-
    length(Children, N),
    append(Children, Flat).

metta_node_var_name([Name-Var|_], Term, Name) :- Var == Term, !.
metta_node_var_name([_|Pairs], Term, Name) :-
    metta_node_var_name(Pairs, Term, Name).

% ~q is the spelling the reader takes back, so 2.0 stays 2.0, a rational stays
% 1r3 and a non-finite float stays inf, -inf or nan. Each of those three is a
% class the engine's own writer already reports as unwritable, and naming them
% at the boundary is what lets the JavaScript side refuse rather than round.
metta_node_number_text(T, Text) :- format(atom(A), '~q', [T]), atom_string(A, Text).

% The inverse. A tag arrives from the host as an atom, and so does every text
% payload, because the WebAssembly conversion has no separate string type on
% the way in. Numbers are read back from their text with the reader, which is
% the only thing that reads every spelling ~q writes.
%
% The names travel with the walk, because a v payload is an IDENTITY WITHIN
% ITS TERM and not a display name: two occurrences of one payload are two
% occurrences of one variable, and (f $x $x) is a different term from
% (f $x $y).
%
% `_` is the one reserved payload and the exception: fresh at every
% occurrence and never recorded, exactly as $_ is in source, so two of them
% constrain nothing.
metta_node_decode(W, T) :- metta_node_decode(W, [], _, T).

% The whole token list must be consumed: tokens left over mean the host wrote
% a term this reader did not finish, which is a refusal rather than a prefix.
metta_node_decode(W, Names0, Names, T) :-
    (   metta_node_decode_(W, Rest, Names0, Names, T),
        Rest == []
    ->  true
    ;   throw(error(metta_node_undecodable(W),
                    context(metta_node_decode/2,
                            'not a wire atom the Node binding writes')))
    ).

metta_node_decode_([Tag, Payload|R], R, Names, Names, T) :- metta_node_tag(Tag, s), !,
    metta_node_atom(Payload, T).
metta_node_decode_([Tag, Payload|R], R, Names, Names, T) :- metta_node_tag(Tag, n), !,
    metta_node_atom(Payload, A),
    metta_node_number(A, T).
metta_node_decode_([Tag, Payload|R], R, Names, Names, T) :- metta_node_tag(Tag, g), !,
    metta_node_atom(Payload, A), atom_string(A, T).
metta_node_decode_([Tag, Payload|R], R, Names, Names, T) :- metta_node_tag(Tag, b), !,
    metta_node_atom(Payload, T), ( T == true ; T == false ).
metta_node_decode_([Tag, Payload|R], R, Names, Names, T) :- metta_node_tag(Tag, p), !,
    metta_node_atom(Payload, T), sub_atom(T, 0, 1, _, '&').
metta_node_decode_([Tag, Payload|R], R, Names, Names, T) :- metta_node_tag(Tag, o), !,
    metta_node_atom(Payload, A),
    atom_number(A, Id),
    integer(Id),
    metta_node_object_atom(Id, T).
metta_node_decode_([Tag, Payload|R], R, Names0, Names, T) :- metta_node_tag(Tag, v), !,
    metta_node_atom(Payload, Name),
    (   Name == '_'
    %The anonymous variable is NOT recorded. Two occurrences of `$_` are two
    %DIFFERENT variables, and the codec's law is that distinct variables come
    %back distinguishable; recording both under `_` made the encoder write `_`
    %twice, and the shared conformance kit reads that as one variable said
    %twice [measured 2026-08-28: node/variable-anonymous, the Python cross-host
    %comparison]. So each one keeps the engine's own fresh name on the way out.
    ->  Names = Names0
    ;   memberchk(Name-Known, Names0)
    ->  T = Known, Names = Names0
    ;   Names = [Name-T|Names0]
    ).
% A child count arrives as a Prolog integer, because that is what the
% WebAssembly conversion makes of a JavaScript number; a host that spelled it
% as text is read too rather than refused, since nothing else could mean it.
% Read INLINE rather than through a helper, because the helper is a call per
% expression on the path every command's arguments take.
metta_node_decode_([Tag, Count|R0], R, Names0, Names, T) :- metta_node_tag(Tag, e), !,
    (   integer(Count)
    ->  N = Count
    ;   metta_node_atom(Count, CA), atom_number(CA, N), integer(N)
    ),
    N >= 0,
    metta_node_decode_items(N, R0, R, Names0, Names, T).

metta_node_decode_items(0, R, R, Names, Names, []) :- !.
metta_node_decode_items(N, R0, R, Names0, Names, [T|Ts]) :-
    N > 0,
    M is N - 1,
    metta_node_decode_(R0, R1, Names0, Names1, T),
    metta_node_decode_items(M, R1, R, Names1, Names, Ts).

% The reader takes back every spelling ~q writes, the non-finite floats
% included: 1.0Inf, -1.0Inf and 1.5NaN all read back as numbers, where the
% MeTTa grammar's own inf, -inf and NaN read as symbols. So one clause covers
% the whole numeric tower and the JavaScript side writes ~q's spelling.
metta_node_number(A, T) :- term_to_atom(T, A), number(T).

metta_node_tag(Tag, Want) :- metta_node_atom(Tag, Want).

metta_node_atom(In, Out) :- atom(In), !, Out = In.
metta_node_atom(In, Out) :- string(In), !, atom_string(Out, In).
metta_node_atom(In, Out) :- number(In), !, atom_number(Out, In).

% A live host value is an object of this bridge's own kind, and it is ATOMIC.
%
% A COMPOUND term that is not a list is not a MeTTa term at all: measured
% 2026-08-27, eval/2 answered nothing for '$metta_node_object'(1), in argument
% position and on its own, while the same handle spelled as an atom passed
% through eval, sat inside an expression and came out of car-atom unchanged.
% That is the same shape janus gives the Python side, where a live object is a
% BLOB and a blob is atomic. The `$` prefix is what makes the name unforgeable
% from MeTTa source: the reader takes a leading `$` as a variable, so no
% program can write one of these by hand.
%
% The seam is the engine's question in front of every grounded-type lookup,
% and answering it is what tells a handle apart from an ordinary symbol.
:- multifile seam:host_object/1.
seam:host_object(Term) :- metta_node_object_id(Term, _).

metta_node_object_atom(Id, Atom) :-
    format(atom(Atom), '$metta_node_object#~d', [Id]).

metta_node_object_id(Term, Id) :-
    atom(Term),
    atom_concat('$metta_node_object#', Digits, Term),
    atom_number(Digits, Id),
    integer(Id).

% MeTTa source text as one atom, through the engine's own reader.
%
% sread_with_names/3 rather than sread/2, so a variable keeps the name the
% SOURCE spelled it with. Without it `(likes ada $drink)` reads back with the
% writer's own counter for a name, and a host that keys an answer row by the
% pattern's variables would key it by `_123` [measured 2026-08-27]. The name
% map is what the engine already carries for exactly this.
metta_node_read(Source, Wire) :-
    metta_node_text(Source, S),
    sread_with_names(S, Term, VarMap),
    metta_node_encode_named(Term, VarMap, Wire).

% A JavaScript string arrives as an atom, because the WebAssembly conversion
% has one text type going in where Prolog has two [measured 2026-08-20].
metta_node_text(In, Out) :- string(In), !, Out = In.
metta_node_text(In, Out) :- atom_string(In, Out).

% Each answer crosses as its wire form AND the engine's own rendering of it.
% The text is not a convenience, and it is PRESENTATION: the display writer
% is the same authority the command line's answers use, so host-only values
% and non-finite floats render beside their wire forms instead of refusing
% the whole answer. Round-trip storage keeps swrite/2's stricter contract.
% The difference-list forms are called directly rather than through their own
% one-clause entry points: this runs once per ANSWER, and a wrapper is an
% inference per answer that the engine's own counter sees
% [measured 2026-08-31: query-rows 240905 with the wrappers, 238905 without].
metta_node_answer('$metta_answer'(Term, NameState), [Wire, Text]) :- !,
    metta_name_pairs(NameState, Names),
    metta_node_encode(Term, Names, _, Wire, []),
    sdisplay_with_names(Term, NameState, Text).
metta_node_answer(Term, [Wire, Text]) :-
    metta_node_encode(Term, [], _, Wire, []),
    sdisplay(Term, Text).

metta_node_group(Terms, Encoded) :-
    maplist(metta_node_answer, Terms, Encoded).

%%%%%%%%%% Jobs: one engine, suspended between events %%%%%%%%%%
%
% An SWI engine is a goal suspended between answers: it "can, if asked,
% resume" after yielding one, which is the answer-stream reading Tarau states
% as design law and wraps in the host's own stream abstraction (A Hitchhiker's
% Guide to Reinventing a Prolog Machine, ICLP 2017, sections 4.5 and 5). The
% JavaScript half wraps this pair in an async iterator for the same reason.
%
% Two kinds of event come out of one engine and the host tells them apart by
% shape. A SOLUTION of the job goal is an answer, a group of answers or a
% value; a YIELD is a request that only the host can satisfy, which is how a
% TypeScript function becomes a MeTTa operation without the engine ever
% holding a JavaScript value. Exhaustion is engine_next/2 failing, so the host
% needs no sentinel.
%
% The engine handle stays HERE and the host holds an integer. A blob has no
% JavaScript identity to hold: the WebAssembly conversion renders every one of
% them as the same opaque {"$t":"b"} [measured 2026-08-20], so a host that
% kept the handle could not hand it back.
metta_node_start(Scopes, Command, Id) :-
    engine_create(Event, metta_node_scoped(Scopes, Command, Event), Engine),
    metta_node_fresh_id(Id),
    assertz(metta_node_job(Id, Engine)).

metta_node_fresh_id(Id) :-
    (   aggregate_all(max(N), metta_node_job(N, _), Highest)
    ->  Id is Highest + 1
    ;   Id = 1
    ).

metta_node_engine(Id, Engine) :-
    (   metta_node_job(Id, Engine)
    ->  true
    ;   throw(error(metta_node_no_job(Id),
                    context(metta_node_step/2, 'this job is closed')))
    ).

% [] is exhaustion and [Event] is one event, so the host needs no sentinel.
metta_node_step(Id, Answer) :-
    metta_node_engine(Id, Engine),
    ( engine_next(Engine, Event) -> Answer = [Event] ; Answer = [] ).

% Answer a host call and take the next event in one crossing, which is what
% engine_post/3 is for.
metta_node_resume(Id, Reply, Answer) :-
    metta_node_engine(Id, Engine),
    ( engine_post(Engine, Reply, Event) -> Answer = [Event] ; Answer = [] ).

% Idempotent: a host that stops after exhaustion, and again from an abandoned
% iterator's return(), finds nothing the second time and is at peace.
metta_node_stop(Id) :-
    (   retract(metta_node_job(Id, Engine))
    ->  catch(engine_destroy(Engine), error(existence_error(_, _), _), true)
    ;   true
    ).

%%%%%%%%%% Scopes: the wrappers a job runs inside %%%%%%%%%%
%
% A scope has to be established INSIDE the engine. An engine has its own
% stack, so a module switch, a stack-limit flag or a transaction opened on the
% host's side of engine_next/2 is not in force within, and current_metta_module/1
% would fall back to &self's however the caller had switched it.
%
% transaction and speculate are the two scopes a host operation cannot fire
% inside, because engine_yield/1 cannot unwind through the nested C query
% frame either of them opens [measured 2026-08-27]. They are here for a plan
% the ENGINE runs by itself; the TypeScript world door is a draft that commits
% through the transaction scope with pure data in hand.
% A scope arrives from the host as a list whose head names it, the same shape
% every other message here takes, and its head arrives as a STRING because the
% WebAssembly conversion has one text type going in. metta_node_atom/2 is
% where the two spellings become one, here as everywhere else in this file.
metta_node_scoped([], Command, Event) :- !,
    metta_node_guarded(Command, Event).
metta_node_scoped([Scope|Rest], Command, Event) :-
    Scope = [Word|Details],
    metta_node_atom(Word, Name),
    metta_node_scope(Name, Details, metta_node_scoped(Rest, Command, Event)).

:- meta_predicate metta_node_scope(+, +, 0).
metta_node_scope(stack, [Bytes], Goal) :- !,
    metta_host_with_stack_limit(Bytes, Goal).
metta_node_scope(module, [Space0], Goal) :- !,
    metta_node_atom(Space0, Space),
    space_module(Space, Module),
    with_metta_module(Module, Goal).
metta_node_scope(transaction, [], Goal) :- !,
    metta_transaction(Goal).
metta_node_scope(speculate, [], Goal) :- !,
    metta_speculate(Goal).
% The engine's own inference budget. There is no TIME scope beside it: a
% WebAssembly SWI has no library(time), so alarm/4 and call_with_time_limit/2
% are absent and a deadline is enforced on the host side by bounding the pull.
% Inferences need neither, and they are the bound that is deterministic under
% load where a wall clock is not.
metta_node_scope(inferences, [Count], Goal) :- !,
    metta_host_inference_budget(Goal, Count, Bounded),
    call(Bounded).
metta_node_scope(Unknown, _, _) :-
    throw(error(metta_node_unknown_scope(Unknown),
                context(metta_node_scope/3, 'this binding has no such scope'))).

% Every job reports what it spent, as its last event.
%
% SWI's inference counter is per ENGINE, so a job's cost cannot be read from
% outside it: asking after the fact measures a different engine, and asking
% before the answers are exhausted measures a prefix. The disjunction's second
% branch runs exactly once, after the command has no more answers, which is
% the one moment the whole cost is known. A job the host abandons never
% reaches it and contributes nothing, which is the truth about work that was
% never asked for.
%
% Inferences are the transport-independent gate the Python side proved;
% crossings and replays are the host's own counters and stay there.
metta_node_guarded(Command, Event) :-
    statistics(inferences, Before),
    (   catch(metta_node_perform(Command, Event),
              Ball,
              ( metta_node_render(Ball, Text), Event = [error, Text] ))
    ;   statistics(inferences, After),
        Spent is After - Before,
        metta_node_number_text(Spent, Text),
        Event = [spent, Text]
    ).

%%%%%%%%%% The command table %%%%%%%%%%
%
% One clause per verb the TypeScript surface needs, each of them a call to
% published engine surface and nothing else. A command that answers many times
% is nondeterministic here and the host pulls; one that answers once is
% deterministic and the host sees a single event followed by exhaustion.
%
% The verb is normalised to an atom BEFORE dispatch and an unknown one is
% refused there, which is what keeps the refusal off the backtracking path: a
% catch-all clause under the table would fire when a real command ran out of
% answers, turning "this space is empty" into "no such command".
metta_node_perform(Command, Event) :-
    (   Command = [Word|Args],
        metta_node_atom(Word, Verb),
        metta_node_verb(Verb)
    ->  metta_node_command(Verb, Args, Event)
    ;   throw(error(metta_node_unknown_command(Command),
                    context(metta_node_perform/2,
                            'this binding has no such command')))
    ).

metta_node_verb(Verb) :- memberchk(Verb, [eval, source, run, load, add, remove,
                                          atoms, count, has, clear, spacenames,
                                          child, restrict, releasable, release,
                                          explain, effect, registerop, dropop,
                                          watch, unwatch, drain, watchpending,
                                          commit,
                                          platform, trace, forms, cast,
                                          disassemble, derivation,
                                          provider, unprovider, runstatus,
                                          reducible,
                                          currentspace, custommatch, digest,
                                          token, untoken]).

% Resolve a world journal pattern to one concrete occurrence before removing
% it. The engine's ordinary bare-variable removal deliberately clears a whole
% space, while one journal entry is one multiset debit.
metta_node_remove_one(Space, Pattern) :-
    (   once((metta_host_stored(Space, Stored), Stored = Pattern))
    ->  metta_host_remove_reported(Space, Stored, _)
    ;   true
    ).

% Evaluate a term already built on the host side. This is the primary door:
% going through text would lose a live host reference, which has no spelling.
metta_node_command(eval, [Wire, Space0], [answer, Out, Text]) :-
    metta_node_atom(Space0, Space),
    metta_node_decode(Wire, Term),
    space_module(Space, Module),
    with_metta_module(Module, eval(Term, Result)),
    metta_node_answer(Result, [Out, Text]).

% Evaluate MeTTa source text, through the engine's own reader.
metta_node_command(source, [Src, Space0], [answer, Out, Text]) :-
    metta_node_atom(Space0, Space),
    metta_node_text(Src, S),
    sread_with_names(S, Term, _Names),
    space_module(Space, Module),
    with_metta_module(Module, eval(Term, Result)),
    metta_node_answer(Result, [Out, Text]).

% Run a program. The grouping walk, the working-dir defaulting and the load
% lifecycle are the engine's own host run surface, shared with the Python
% shim; this side maps its codec over the term groups and nothing else. One
% encoded group per ! directive, in source order.
metta_node_command(run, [Src], [groups, Groups]) :-
    metta_node_text(Src, S),
    metta_host_run_source(S, '&self', [], TermGroups),
    maplist(metta_node_group, TermGroups, Groups).

% A file, loaded through the same engine door import! uses, so the file is
% recorded under the canonical path both doors key on and a reload replaces
% the first load's definitions rather than doubling them.
metta_node_command(load, [File0], [groups, Groups]) :-
    metta_node_atom(File0, File),
    metta_host_load_file(File, '&self', TermGroups),
    maplist(metta_node_group, TermGroups, Groups).

metta_node_command(add, [Space0, Wires], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    maplist(metta_node_decode, Wires, Terms),
    metta_add_atoms(Space, Terms).

metta_node_command(remove, [Space0, Wire], [value, [b, Verdict]]) :-
    metta_node_atom(Space0, Space),
    metta_node_decode(Wire, Term),
    metta_host_remove_reported(Space, Term, Verdict).

metta_node_command(atoms, [Space0], [answer, Out, Text]) :-
    metta_node_atom(Space0, Space),
    metta_host_stored(Space, Term),
    metta_node_answer(Term, [Out, Text]).

metta_node_command(count, [Space0], [value, [n, Text]]) :-
    metta_node_atom(Space0, Space),
    aggregate_all(count, metta_host_stored(Space, _), N),
    metta_node_number_text(N, Text).

% Existence is asked against a COPY, so the probe's own bindings cannot
% narrow the question the caller asked.
metta_node_command(has, [Space0, Wire], [value, [b, Verdict]]) :-
    metta_node_atom(Space0, Space),
    metta_node_decode(Wire, Term),
    (   \+ \+ ( metta_host_stored(Space, Stored), Stored = Term )
    ->  Verdict = true
    ;   Verdict = false
    ).

metta_node_command(clear, [Space0], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    metta_host_clear_space(Space).

metta_node_command(spacenames, [], [value, Wire]) :-
    metta_space_names(Names),
    maplist(metta_node_space_wire, Names, Wires),
    metta_node_expr_wire(Wires, Wire).

% The engine's own platform census, which this host READS rather than
% recovering by regex over SWI's stderr. A WebAssembly build has no threads,
% no timers and no processes, and the engine now names each capability it
% lacks and what the absence costs instead of letting three directives fail
% loudly; nothing is printed, so a boot transcript carrying any ERROR: line is
% an unnamed refusal and src/engine.ts refuses it, which is strictly stronger
% than matching against a table this file used to keep in step by hand.
% Every cell crosses as text so the host reads the row without decoding atoms.
metta_node_command(platform, [], [value, Wire]) :-
    findall(Row,
            ( metta_platform(Capability, Status, Requires, Cost),
              atom_string(Capability, Name),
              atom_string(Status, State),
              term_string(Requires, Needs),
              text_to_string(Cost, Costs),
              metta_node_expr_wire([[g, Name], [g, State], [g, Needs], [g, Costs]], Row) ),
            Rows),
    metta_node_expr_wire(Rows, Wire).

metta_node_command(child, [Child0, Parent0], [value, [s, "ok"]]) :-
    metta_node_atom(Child0, Child),
    metta_node_atom(Parent0, Parent),
    metta_declare_space_parent(Child, Parent).

metta_node_command(restrict, [Space0, Grants0], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    maplist(metta_node_atom, Grants0, Grants),
    metta_declare_restricted_space(Space, Grants).

metta_node_command(releasable, [Space0], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    metta_assert_space_releasable(Space).

metta_node_command(release, [Space0], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    metta_release_space(Space).

% The engine's own account of how a match will be answered: which conjuncts a
% provider claimed, which the engine joins itself, and why one was refused.
% Prose is the host's own presentation, so the report crosses as its term.
metta_node_command(explain, [Space0, Wires], [value, [g, Text]]) :-
    metta_node_atom(Space0, Space),
    maplist(metta_node_decode, Wires, Patterns),
    metta_host_explain_match(Space, Patterns, Report),
    term_string(Report, Text).

metta_node_command(effect, [Name0], [value, [s, Text]]) :-
    metta_node_atom(Name0, Name),
    (   metta_operation_effect(Name, Class)
    ->  atom_string(Class, Text)
    ;   Text = "unknown"
    ).

metta_node_command(registerop, [Name0, Arity, Kind0, Effect0], [value, [s, "ok"]]) :-
    metta_node_atom(Name0, Name),
    metta_node_atom(Kind0, Kind),
    metta_node_atom(Effect0, Effect),
    metta_node_register_op(Name, Arity, Kind, Effect).

metta_node_command(dropop, [Name0, Arity], [value, [s, "ok"]]) :-
    metta_node_atom(Name0, Name),
    metta_node_drop_op(Name, Arity).

metta_node_command(watch, [WatchId, Space0, Wire, Edges0], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    metta_node_decode(Wire, Pattern),
    maplist(metta_node_atom, Edges0, Edges),
    retractall(metta_node_watch(WatchId, _, _, _)),
    assertz(metta_node_watch(WatchId, Space, Pattern, Edges)).

metta_node_command(unwatch, [WatchId], [value, [s, "ok"]]) :-
    retractall(metta_node_watch(WatchId, _, _, _)),
    retractall(metta_node_event(WatchId, _, _)).

% How many admissions this watch has queued and the host has not taken.
%
% The host needs it to say whether a write has been SEEN, which it cannot know
% from its own side: the watch is polled, so an event exists here before any
% poll fetches it. A subscription's `settled()` reads this and its own
% taken-against-delivered counters, which together close the window a poll
% leaves open [tested: settles on the engine's own queue rather than on a sleep].
metta_node_command(watchpending, [WatchId0], [value, [n, Text]]) :-
    metta_node_number_arg(WatchId0, WatchId),
    aggregate_all(count, metta_node_event(WatchId, _, _), Pending),
    metta_node_number_text(Pending, Text).

% Drain the queue, one admission per pull, oldest first. retract/1 on
% backtracking takes the next one, which is the standard queue walk.
metta_node_command(drain, [WatchId], [admission, Edge, Wire, Text]) :-
    retract(metta_node_event(WatchId, Edge, Wire)),
    metta_node_decode(Wire, Term),
    sdisplay(Term, Text).

% Apply a world's recorded delta to its parent, atomically. By the time this
% runs the delta is pure data, so the transaction scope around it is safe:
% nothing left in it needs to yield to the host.
metta_node_command(commit, [Child0, Parent0, RemoveWires], [value, [s, "ok"]]) :-
    metta_node_atom(Child0, Child),
    metta_node_atom(Parent0, Parent),
    maplist(metta_node_decode, RemoveWires, Removals),
    findall(A, metta_host_stored(Child, A), Added),
    forall(member(R, Removals), metta_node_remove_one(Parent, R)),
    metta_add_atoms(Parent, Added),
    metta_host_clear_space(Child).

% The space the ENGINE is evaluating in right now. Asked from inside a host
% operation it answers the space of the program that called it, because the
% operation runs inside that program's own module; asked from outside any
% evaluation it answers the default.
metta_node_command(currentspace, [], [value, [p, Text]]) :-
    current_metta_space(Space),
    atom_string(Space, Text).

% Run source and report, per directive, whether the engine REDUCED it. The
% status words are the engine's own: value for a directive that reduced,
% not-reducible for one that answered itself, and empty for a pruned branch.
% The answers ride beside the statuses, so a strict scope runs the source ONCE
% and refuses on what it sees, rather than running it to judge it and again to
% keep it.
metta_node_command(runstatus, [Src0, Space0], [value, Wire]) :-
    metta_node_text(Src0, Src),
    metta_node_atom(Space0, Space),
    metta_host_run_source_status(Src, Space, Raw),
    maplist(metta_node_status_group, Raw, Groups),
    metta_node_expr_wire(Groups, Wire).

% Whether the engine has anything to apply to a term's HEAD in this space.
%
% metta_reducible_head/2 is the translator's own test, published as a host
% service in engine/ext_points.pl, and it is the very predicate
% metta_host_run_source_status/3 asks of a directive to decide between value
% and not-reducible. Asking the same one here is what keeps the TERM door and
% the SOURCE door from disagreeing about the word; a host-side rule such as
% "the answer equals the question" would also refuse a genuine fixpoint.
metta_node_command(reducible, [Space0, Wire], [value, [b, Verdict]]) :-
    metta_node_atom(Space0, Space),
    metta_node_decode(Wire, Term),
    (   space_module(Space, Module)
    ->  true
    ;   Module = user
    ),
    (   metta_reducible_head(Module, Term)
    ->  Verdict = true
    ;   Verdict = false
    ).

% The reduction trace: the engine's own call and exit events for one source
% run, bounded by a maximum event count so a runaway reduction still answers.
% Each row is (Depth Kind Term) or (Depth Kind Term Answer), built as MeTTa
% terms and encoded once, because the codec already spells a term and a second
% hand-written encoder is a second thing to keep right.
metta_node_command(trace, [Src0, Space0, Max0], [value, Wire]) :-
    metta_node_text(Src0, Src),
    metta_node_atom(Space0, Space),
    metta_node_number_arg(Max0, Max),
    metta_trace_source(Src, Space, Max, Events),
    maplist(metta_node_trace_row, Events, Rows),
    metta_node_expr_wire(Rows, Wire).

% Every top-level form of some source, read but NOT evaluated, each with the
% kind the engine's own reader gave it. The wire carries the parsed atom
% beside its kind, so a caller that wants the terms does not pay a second
% crossing per form to parse the text again.
metta_node_command(forms, [Src0], [value, Wire]) :-
    metta_node_text(Src0, Src),
    metta_host_read_forms(Src, Pairs),
    maplist(metta_node_form_row, Pairs, Rows),
    metta_node_expr_wire(Rows, Wire).

% Whether this space's type discipline admits a value as a type, and the types
% it does hold when it does not. get-metatype answers for a value the type
% system has no declaration for, which is what makes a cast to Number succeed
% on 3 without anybody having declared it.
metta_node_command(cast, [Space0, ValueW, TypeW], [value, Verdict]) :-
    metta_node_atom(Space0, Space),
    metta_node_decode(ValueW, Value),
    metta_node_decode(TypeW, Type),
    space_module(Space, Module),
    (   with_metta_module(Module,
            ( 'get-type'(Value, Type) *-> true ; 'get-metatype'(Value, Type) ))
    ->  Verdict = [b, "true"]
    ;   with_metta_module(Module, findall(T, 'get-type'(Value, T), Types)),
        maplist(metta_node_encode, Types, TypeWires),
        metta_node_expr_wire(TypeWires, Verdict)
    ).

% The Prolog clauses one MeTTa name compiled to, in this space's module: the
% engine's own listing, which is the bottom rung of the power ladder this
% surface promises. The listing is a READ, so a deferred function would show
% nothing and register no arity: the disassembly IS the demand.
metta_node_command(disassemble, [Space0, Name0], [value, [g, Text]]) :-
    metta_node_atom(Space0, Space),
    metta_node_atom(Name0, Name),
    spaces:metta_ensure_compiled(Name),
    findall(A, arity(Name, A), Arities0),
    Arities0 \== [],
    sort(Arities0, Arities),
    space_module(Space, Module),
    with_output_to(string(Text),
                   forall(member(A, Arities),
                          (   current_predicate(Module:Name/A)
                          ->  listing(Module:Name/A)
                          ;   true ))).

% A space whose atoms live in TypeScript. The engine-side claim comes first,
% so a name another provider already owns is refused here by name rather than
% resolving by load order later; the capability rows are this space's own, and
% an events promise rides the same registration because delivery is one fact
% about one space rather than a second crossing.
metta_node_command(provider, [Space0, Caps0, Delivery0], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    metta_node_require_space_name(Space),
    metta_claim_space(Space, node),
    ( metta_node_foreign(Space) -> true ; assertz(metta_node_foreign(Space)) ),
    metta_node_claim_owned(Space),
    metta_source_reset(Space),
    retractall(metta_node_capability(Space, _)),
    forall(member(Cap0, Caps0),
           ( metta_node_atom(Cap0, Cap),
             assertz(metta_node_capability(Space, Cap)) )),
    metta_node_declare_delivery(Space, Delivery0).

metta_node_command(unprovider, [Space0], [value, [s, "ok"]]) :-
    metta_node_atom(Space0, Space),
    retractall(metta_node_capability(Space, _)),
    metta_node_declare_delivery(Space, []),
    retractall(metta_node_foreign(Space)),
    metta_node_disclaim_owned(Space),
    metta_disclaim_space(Space, node).

% A space's content as one sha256, through the engine's own canonicalization:
% each atom copied fresh with numbered variables so alpha-equivalent equations
% print identically in every process, the lines multiset-sorted so insertion
% order cannot matter, then hashed as one utf8 document. A live host object
% prints by address, so a space holding one is refused by name rather than
% given a hash that means nothing outside this process.
metta_node_command(digest, [Space0], [value, [s, Hash]]) :-
    metta_node_atom(Space0, Space),
    metta_host_digest(Space, Outcome),
    metta_node_digest_result(Outcome, Space, Hash).


% A reader class of this host's own: a full-token regex and the key the host
% answers construction under. The engine keeps the pattern and hands the key
% back through seam:host_reader_token_construct/3 when the reader meets a
% lexeme that matches, so the callable never leaves this side.
metta_node_command(token, [Pattern0, Key0], [value, [s, "ok"]]) :-
    metta_node_atom(Pattern0, Pattern),
    metta_node_atom(Key0, Key),
    metta_node_token_enable,
    metta_host_register_reader_token(Pattern, Key).

metta_node_command(untoken, [Pattern0], [value, [s, "ok"]]) :-
    metta_node_atom(Pattern0, Pattern),
    metta_host_unregister_reader_token(Pattern).

% Turn host-owned matching on or off. On is idempotent; off clears the memo
% with the clauses, so a class registered again is probed again.
metta_node_command(custommatch, [On0], [value, [s, "ok"]]) :-
    metta_node_atom(On0, On),
    (   On == true
    ->  metta_node_custom_match_enable
    ;   metta_node_custom_match_disable
    ).

% Every proof of one answer, as a tree in MeTTa terms. One answer per proof,
% so a host that wants the first stops pulling and the rest are never walked.
metta_node_command(derivation, [Space0, Wire, Depth0], [answer, Out, Text]) :-
    metta_node_atom(Space0, Space),
    metta_node_number_arg(Depth0, Depth),
    metta_node_derivation(Space, Wire, Depth, Tree),
    metta_node_encode(Tree, Out),
    sdisplay(Tree, Text).

% The readers and writers the commands above use. They sit BELOW the command
% table rather than beside the clause that needs each one, so every
% metta_node_command/3 clause stays contiguous: SWI warns about a
% discontiguous predicate on stderr, and this binding's own suite refuses
% any engine output at all.
metta_node_status_group(Rows, Group) :-
    maplist(metta_node_status_row, Rows, Encoded),
    metta_node_expr_wire(Encoded, Group).

metta_node_status_row([Status, Answer], Row) :-
    metta_node_atom_text(Status, Word),
    metta_node_answer(Answer, [Wire, Text]),
    metta_node_expr_wire([[s, Word], Wire, [g, Text]], Row).

metta_node_trace_row(event(Depth, call, Term, _, Names), Row) :- !,
    metta_node_number_text(Depth, DepthText),
    metta_node_encode_with_names(Names, Term, Encoded),
    metta_node_expr_wire([[n, DepthText], [s, "call"], Encoded], Row).
metta_node_trace_row(event(Depth, exit, Term, Answer, Names), Row) :-
    metta_node_number_text(Depth, DepthText),
    metta_node_encode_with_names(Names, Term, Encoded),
    metta_node_encode_with_names(Names, Answer, EncodedAnswer),
    metta_node_expr_wire([[n, DepthText], [s, "exit"], Encoded, EncodedAnswer], Row).

metta_node_form_row([Kind, Text], Row) :-
    metta_node_atom_text(Kind, KindText),
    metta_node_text(Text, TextString),
    metta_node_read(TextString, Wire),
    metta_node_expr_wire([[s, KindText], [g, TextString], Wire], Row).

metta_node_atom_text(In, Out) :- atom(In), !, atom_string(In, Out).
metta_node_atom_text(In, Out) :- metta_node_text(In, Out).

metta_node_number_arg(In, Out) :- number(In), !, Out = In.
metta_node_number_arg(In, Out) :- metta_node_atom(In, A), atom_number(A, Out).

metta_node_space_wire(Name, [p, Text]) :- atom_string(Name, Text).

%%%%%%%%%% Host operations %%%%%%%%%%
%
% A TypeScript function becomes a MeTTa operation the way every other host's
% does: prove the name is free, assert a dispatch clause into the base tier's
% module, then make the engine treat the name as a function. The engine
% publishes that protocol as four calls and this file performs them in order;
% the effect class travels with the registration, as a (effect Name Class)
% atom in the catalog, because a registered name needs a reviewed class before
% a world can decide whether to admit it.
%
% The dispatch clause is the only part that is this binding's own, and it is
% the whole trampoline: encode the arguments, yield the request, take the
% host's reply and unify. Nothing about it is Node-specific, which is the
% point: the same clause works over a socket or a worker.
metta_node_register_op(Name, Arity, Kind, Effect) :-
    PredArity is Arity + 1,
    (   metta_node_op(Name, Arity, _)
    ->  true
    ;   metta_host_open_function(Name, node, PredArity)
    ),
    metta_node_drop_clauses(Name, Arity),
    length(Args, Arity),
    append(Args, [Result], HeadArgs),
    Head =.. [Name | HeadArgs],
    metta_node_op_body(Kind, Name, Args, Result, Body),
    space_module('&self', Base),
    assertz(Base:(Head :- Body)),
    assertz(metta_node_op(Name, Arity, Kind)),
    metta_node_declare_effect(Name, Effect),
    metta_host_adopt_function(Name, node, Kind, PredArity).

% det answers once, many answers as often as the host has answers for. The
% raw kinds differ only in what the HOST hands its own callback, an atom
% rather than an unwrapped value, so they share these two bodies and the
% catalog still records which one was registered.
metta_node_op_body(many, Name, Args, Result,
                   metta_node_dispatch_many(Name, Args, Result)) :- !.
metta_node_op_body(raw_many, Name, Args, Result,
                   metta_node_dispatch_many(Name, Args, Result)) :- !.
metta_node_op_body(_, Name, Args, Result,
                   metta_node_dispatch_det(Name, Args, Result)).

metta_node_declare_effect(Name, Effect) :-
    metta_add_atoms('&metta', [[effect, Name, Effect]]).

metta_node_drop_clauses(Name, Arity) :-
    PredArity is Arity + 1,
    (   metta_node_op(Name, Arity, _)
    ->  metta_host_drop_function(Name, PredArity),
        retractall(metta_node_op(Name, Arity, _))
    ;   true
    ).

metta_node_drop_op(Name, Arity) :-
    metta_node_drop_clauses(Name, Arity),
    (   metta_node_op(Name, _, _)
    ->  true
    ;   metta_host_forget_function(Name)
    ).

% The engine asks who a dispatch goal really is, so a purity refusal names the
% operation rather than this file's dispatcher.
:- multifile seam:effect_operation_name/3.
seam:effect_operation_name(metta_node_dispatch_det(Name, Args, _), Name, Arity) :-
    length(Args, Arity).
seam:effect_operation_name(metta_node_dispatch_many(Name, Args, _), Name, Arity) :-
    length(Args, Arity).

metta_node_dispatch_det(Name, Args, Result) :-
    metta_node_ask(Name, Args, Reply, Names),
    metta_node_det_reply(Reply, Names, Result).

% The reply decodes against the map the CALL was encoded under, never against
% one rebuilt afterwards: a variable the host answers is then the caller's own
% variable, whatever the stack did in between.
metta_node_det_reply([ok, Wire], Names, Result) :- !,
    metta_node_decode(Wire, Names, _, Result).
metta_node_det_reply([fail], _, _) :- !, fail.
metta_node_det_reply([error, Text], _, _) :- !, metta_node_host_throw(Text).
metta_node_det_reply(Reply, _, _) :-
    throw(error(metta_node_bad_reply(Reply),
                context(metta_node_dispatch_det/3, 'the host answered nothing this side reads'))).

metta_node_dispatch_many(Name, Args, Result) :-
    metta_node_ask(Name, Args, Reply, Names),
    metta_node_many_reply(Reply, Names, Result).

% A host operation that answers a whole set at once sends [many, Wires]; one
% that answers lazily sends [stream] and then one answer per pull, which is
% what an ordinary JavaScript generator or async generator gives without
% being drained first. Backtracking into the disjunction is what asks for the
% next one, so laziness on this side and laziness on that side are one thing.
metta_node_many_reply([many, Wires], Names, Result) :- !,
    member(Wire, Wires),
    metta_node_decode(Wire, Names, _, Result).
metta_node_many_reply([stream, Id], Names, Result) :- !,
    metta_node_pull(Id, Names, Result).
metta_node_many_reply([fail], _, _) :- !, fail.
metta_node_many_reply([error, Text], _, _) :- !, metta_node_host_throw(Text).
metta_node_many_reply(Reply, _, _) :-
    throw(error(metta_node_bad_reply(Reply),
                context(metta_node_dispatch_many/3, 'the host answered nothing this side reads'))).

% Each pull names its own STREAM, because more than one can be live at once: a
% conjunction over a provider space opens an inner enumeration while the outer
% one is suspended, and both have to be resumable. Without the id the host held
% a single iterator, the inner replaced the outer, and the outer answered its
% first row and stopped -- silently, which is the worst way for a matcher to be
% wrong [measured 2026-08-28: a three-edge cycle answered one of its three
% paths through a TypeScript-backed space and all three through a native one].
%
% repeat/0 rather than recursion, so the frame count does NOT grow with the
% number of answers pulled. The recursive shape left one choice point and one
% frame per answer and died inside swipl-wasm's own query at about eight
% thousand of them [measured 2026-08-27]; this one is flat, and a host
% operation may answer as long as it likes.
metta_node_pull(Id, Names, Result) :-
    repeat,
    metta_node_yield([pull, Id]),
    engine_fetch(Reply),
    (   Reply = [ok, Wire]
    ->  metta_node_decode(Wire, Names, _, Result)
    ;   Reply = [done]
    ->  !, fail
    ;   Reply = [error, Text]
    ->  !, metta_node_host_throw(Text)
    ;   !, throw(error(metta_node_bad_reply(Reply),
                       context(metta_node_pull/1,
                               'the host answered nothing this side reads')))
    ).

% The call carries the SPACE the reduction is running in, because the host
% cannot ask for it afterwards: current_metta_space/1 read from a new job
% answers that job's own module, not the suspended one's, and an operation
% that wanted to behave per-space would have been told the default every time
% [measured 2026-08-28]. Sending it with the call is the only place it is
% knowable.
metta_node_ask(Name, Args, Reply) :- metta_node_ask(Name, Args, Reply, _).

metta_node_ask(Name, Args, Reply, Names) :-
    metta_node_encode_arguments(Args, [], Names, Wires),
    metta_node_call_event(Name, Wires, Event),
    metta_node_yield(Event),
    engine_fetch(Reply).

% The space rides the call ONLY when it is not the default, so a program that
% never left &self sends the three-element event it always did and pays for
% none of this. The host reads a missing fourth element as "the default", and
% falls back to asking the engine, which answers the same thing.
metta_node_call_event(Name, Wires, [call, Name, Wires, Where]) :-
    current_metta_space(Space),
    Space \== '&self',
    !,
    atom_string(Space, Where).
metta_node_call_event(Name, Wires, [call, Name, Wires]).

% SWI's own diagnostic for a yield outside an engine names a virtual machine
% instruction, which tells an author of TypeScript nothing. The two places a
% reduction can be running without one are a transaction scope and a direct
% Prolog call, and both have a remedy worth naming.
metta_node_yield(Request) :-
    catch(engine_yield(Request),
          error(permission_error(execute, _, _), _),
          throw(error(metta_node_not_in_engine(Request),
                      context(metta_node_yield/1,
                              'a host operation was reached where the engine \c
                               cannot suspend: it is running outside a job, or \c
                               inside a transaction or speculate scope, and \c
                               engine_yield/1 cannot unwind through either')))).

metta_node_host_throw(Text) :-
    metta_node_atom(Text, Message),
    throw(error(metta_node_host_error(Message),
                context(metta_node_host_throw/1, 'a host operation raised'))).

:- multifile prolog:error_message//1.
prolog:error_message(metta_node_host_error(Message)) -->
    [ 'the host operation raised: ~w'-[Message] ].
prolog:error_message(metta_node_not_in_engine(_)) -->
    [ 'a host operation cannot answer here: the engine has no suspension \c
       point'-[] ].

%%%%%%%%%% Watching a space %%%%%%%%%%
%
% A live query is the engine's own admission event, queued. The two hooks are
% the engine's atom events; each one records the wire form of every admission
% a standing pattern matches, and the host drains the queue when it asks for
% the next one. Matching is against a COPY, so a watch pattern's variables
% never bind into the atom the space is storing.
:- multifile seam:atom_added/2.
seam:atom_added(Space, Atom) :-
    metta_node_note(add, Space, Atom).

:- multifile seam:atom_removed/2.
seam:atom_removed(Space, Atom) :-
    metta_node_note(remove, Space, Atom).

metta_node_note(Edge, Space, Atom) :-
    forall(( metta_node_watch(WatchId, Space, Pattern, Edges),
             memberchk(Edge, Edges),
             \+ \+ Pattern = Atom ),
           metta_node_queue(WatchId, Edge, Atom)).

metta_node_queue(WatchId, Edge, Atom) :-
    catch(( metta_node_encode(Atom, Wire),
            assertz(metta_node_event(WatchId, Edge, Wire)) ),
          _,
          true).

%%%%%%%%%% Derivation trees %%%%%%%%%%
%
% The classic proof-tree meta-interpreter, rendered in MeTTa terms: every
% compiled clause remembers its source equation through translated_from/2, so
% each node names the equation that fired, a stored atom is a leaf, and a
% builtin call is an opaque leaf. Control constructs recurse into the branch
% they execute. A finite depth emits a truncated node rather than claiming no
% proof; a negative depth is unbounded, and the host bounds that search with
% the same scopes evaluation uses.
%
% Ported from the Python seat's own walker, which is the shipped and tested
% one; what differs here is only the encoding, because this codec spells a
% MeTTa term directly and the tree IS one.

metta_node_derivation(Space, Wire, Depth, Tree) :-
    metta_node_decode(Wire, Term),
    Term = [F|Args],
    atom(F),
    append(Args, [Out], FullArgs),
    Goal =.. [F|FullArgs],
    space_module(Space, Module),
    with_metta_module(Module, metta_node_solve(Module, Goal, Depth, Steps)),
    Tree = [derivation, [answer, [F|Args], Out] | Steps].

metta_node_solve(M, Goal, D, Tree) :-
    metta_node_solve_barrier(M, Goal, D, Tree, _).

% A cut prunes the clauses that follow it and the choicepoints that precede it
% in the same body. Recorded as a leaf and simply called it pruned neither, so
% the tree proved conclusions the program cannot reach. That is the naive
% incorporation the literature names and rejects: what has to be modelled is
% the cut's SCOPE, the clause in which the cut is a goal [source: Sterling and
% Shapiro, The Art of Prolog, 2nd ed., p327, ch17]. Passing a cut signal
% upward prunes the later clauses but not the earlier goals, so the cut throws
% instead, and every construct that is a cut barrier in Prolog catches its own
% throw and turns it into failure.
metta_node_solve_barrier(M, Goal, D, Tree, Status) :-
    gensym('$metta_node_cut_', Barrier),
    catch(metta_node_solve_(M, Goal, D, Tree, Status, Barrier),
          metta_node_cut(Barrier),
          fail).

metta_node_solve_(_, Goal, 0, [[truncated, Text]], truncated, _) :- !,
    term_string(Goal, Text).
metta_node_solve_(_, true, _, [], complete, _) :- !.
metta_node_solve_(_, '!', _, [[builtin, "!"]], complete, Barrier) :- !,
    ( true ; throw(metta_node_cut(Barrier)) ).
metta_node_solve_(M, (If -> Then ; Else), D, Tree, Status, Barrier) :- !,
    (   metta_node_solve_barrier(M, If, D, IfTree, IfStatus)
    ->  (   IfStatus == truncated
        ->  Tree = IfTree, Status = truncated
        ;   metta_node_solve_(M, Then, D, ThenTree, Status, Barrier),
            append(IfTree, ThenTree, Tree) )
    ;   metta_node_solve_(M, Else, D, Tree, Status, Barrier) ).
metta_node_solve_(M, (If -> Then), D, Tree, Status, Barrier) :- !,
    (   metta_node_solve_barrier(M, If, D, IfTree, IfStatus)
    ->  (   IfStatus == truncated
        ->  Tree = IfTree, Status = truncated
        ;   metta_node_solve_(M, Then, D, ThenTree, Status, Barrier),
            append(IfTree, ThenTree, Tree) )
    ;   fail ).
% The SOFT cut, which the engine writes wherever a call must keep every answer
% and still have an else arm. Without these two clauses the pair below reads
% the whole construct as one opaque builtin, so a proof stops at the wrapper
% instead of descending into the call it wraps. They sit ABOVE the plain
% disjunction because `( If *-> Then ; Else )` IS a disjunction whose left
% side is the soft cut, and that reading loses the else arm's condition.
metta_node_solve_(M, (If *-> Then ; Else), D, Tree, Status, Barrier) :- !,
    (   metta_node_solve_barrier(M, If, D, IfTree, IfStatus)
    *-> (   IfStatus == truncated
        ->  Tree = IfTree, Status = truncated
        ;   metta_node_solve_(M, Then, D, ThenTree, Status, Barrier),
            append(IfTree, ThenTree, Tree) )
    ;   metta_node_solve_(M, Else, D, Tree, Status, Barrier) ).
metta_node_solve_(M, (If *-> Then), D, Tree, Status, Barrier) :- !,
    metta_node_solve_barrier(M, If, D, IfTree, IfStatus),
    (   IfStatus == truncated
    ->  Tree = IfTree, Status = truncated
    ;   metta_node_solve_(M, Then, D, ThenTree, Status, Barrier),
        append(IfTree, ThenTree, Tree) ).
metta_node_solve_(M, (A ; B), D, Tree, Status, Barrier) :- !,
    (   metta_node_solve_(M, A, D, Tree, Status, Barrier)
    ;   metta_node_solve_(M, B, D, Tree, Status, Barrier) ).
metta_node_solve_(M, (A , B), D, Tree, Status, Barrier) :- !,
    metta_node_solve_(M, A, D, TA, SA, Barrier),
    (   SA == truncated
    ->  Tree = TA, Status = truncated
    ;   metta_node_solve_(M, B, D, TB, Status, Barrier),
        append(TA, TB, Tree) ).
metta_node_solve_(M, call(A), D, Tree, Status, _) :- !,
    metta_node_solve_barrier(M, A, D, Tree, Status).
metta_node_solve_(M, once(A), D, Tree, Status, _) :- !,
    once(metta_node_solve_barrier(M, A, D, Tree, Status)).
metta_node_solve_(M, \+ A, D, Tree, Status, _) :- !,
    (   once(metta_node_solve_barrier(M, A, D, TA, SA))
    ->  (   SA == truncated
        ->  Tree = TA, Status = truncated
        ;   fail )
    ;   term_string(\+ A, Text), Tree = [[builtin, Text]], Status = complete ).
metta_node_solve_(M, findall(Template, Goal, List), D, Tree, Status, _) :- !,
    findall([Template, SubTree, SubStatus],
            metta_node_solve_barrier(M, Goal, D, SubTree, SubStatus),
            Results),
    metta_node_findall_results(Results, Values, Tree, Status),
    ( Status == complete -> List = Values ; true ).
% The dispatcher is engine machinery, but its shipped fast path wraps an
% ordinary generated goal. Treating the wrapper as a generic Prolog predicate
% enumerates its implementation clauses as separate proofs and runs the
% wrapped recursion through call/1, outside the depth counter. Open the fast
% path and keep its direct goal inside this interpreter; a non-default policy
% is executed by the authoritative dispatcher and recorded as one leaf.
metta_node_solve_(_,
                  dispatch_policy_execute(Module, Fun, Args, Goal, Out),
                  D, Tree, Status, Barrier) :- !,
    metta_host_dispatch_proof_step(Module, Fun, Args, Goal, Out, Route),
    (   Route == direct
    ->  metta_node_solve_(Module, Goal, D, Tree, Status, Barrier)
    ;   Route == opaque,
        term_string(dispatch_policy_execute(Module, Fun, Args, Goal, Out), Text),
        Tree = [[builtin, Text]],
        Status = complete
    ).
% The application and boundary result protocols only classify the value the
% preceding goal produced. They are transparent proof steps: retaining a call
% is not another premise and must not turn a recursive MeTTa call into an
% opaque leaf.
metta_node_solve_(M, metta_application_result(Written, Produced, Out), _,
                  [], complete, _) :- !,
    call(M:metta_application_result(Written, Produced, Out)).
metta_node_solve_(M, metta_application_result(Source, Runtime, Produced, Out), _,
                  [], complete, _) :- !,
    call(M:metta_application_result(Source, Runtime, Produced, Out)).
metta_node_solve_(M, metta_boundary_result(Written, Produced, Out), _,
                  [], complete, _) :- !,
    call(M:metta_boundary_result(Written, Produced, Out)).
% A clause compiled from a MeTTa equation is a step worth showing, and its
% body is walked further. Everything else, engine machinery and space facts
% alike, is called whole and appears as one leaf, so the tree stays in MeTTa
% terms. One barrier serves every clause of the goal, because a cut in the
% body of one clause discards the clauses after it as well as its own
% alternatives.
metta_node_solve_(M, Goal, D, Tree, Status, _) :-
    \+ predicate_property(M:Goal, built_in),
    gensym('$metta_node_cut_', Barrier),
    catch(metta_node_solve_clause(M, Goal, D, Tree, Status, Barrier),
          metta_node_cut(Barrier),
          fail).
metta_node_solve_(M, Goal, _, [[builtin, Text]], complete, _) :-
    predicate_property(M:Goal, built_in), !,
    term_string(Goal, Text),
    call(M:Goal).

% A clause's body runs in the module that DEFINES the clause, which is the
% space's module for a MeTTa equation and an engine subsystem's for engine
% machinery. clause/2 is a READ, not a call, so the undefined-predicate net
% never fires for a deferred callee: the name is forced at every step, because
% the tree descends into callees the running program may never have reached.
metta_node_solve_clause(M, Goal, D, Tree, Status, Barrier) :-
    (   Goal =.. [Predicate|_],
        translator:compiled_function_name(Fun, Predicate)
    ->  spaces:metta_ensure_compiled(Fun)
    ;   true
    ),
    metta_node_clause_owner(M, Goal, Owner),
    catch_recover(clause(Owner:Goal, Body, Ref), fail),
    (   translated_from(Ref, Source)
    ->  metta_node_next_depth(D, D1),
        metta_node_body_after_stack_charge(Owner, Body, Premises),
        metta_node_solve_(Owner, Premises, D1, Sub, Status, Barrier),
        metta_node_call_node(Goal, CallNode),
        Tree = [[step, CallNode, Source | Sub]]
    ;   call(Owner:Body),
        metta_node_leaf(M, Goal, Tree),
        Status = complete
    ).

% catch_recover/2 rather than catch/3, because this runs once per level and a
% blanket catch swallows the very signals that stop an unbounded walk.
metta_node_clause_owner(M, Goal, Owner) :-
    (   catch_recover(predicate_property(M:Goal,
                                         implementation_module(Definer)),
                      fail)
    ->  Owner = Definer
    ;   Owner = M
    ).

% A recursive equation's clause opens with the stack charge the engine writes
% in front of the translated body. That charge is the engine counting its own
% recursion depth, not a premise of the program being proved, so it
% contributes no node. It is RECOGNISED by the engine rather than by a shape
% spelled again here, and CALLED at the point the body would have run it, so a
% proof walked inside an open scope is charged exactly as evaluation is.
metta_node_body_after_stack_charge(Owner, Body, Premises) :-
    metta_host_stack_charge(Body, Charge, Premises), !,
    call(Owner:Charge).
metta_node_body_after_stack_charge(_, Body, Body).

metta_node_findall_results([], [], [], complete).
metta_node_findall_results([[Value, SubTree, SubStatus]|Results],
                           [Value|Values], Tree, Status) :-
    metta_node_findall_results(Results, Values, RestTree, RestStatus),
    append(SubTree, RestTree, Tree),
    ( SubStatus == truncated -> Status = truncated ; Status = RestStatus ).

metta_node_next_depth(D, D) :- D < 0, !.
metta_node_next_depth(D, D1) :- D1 is D - 1.

% A compiled goal f(A1..An,Out) reads as the call (f A1..An) with its answer.
metta_node_call_node(Goal, [call, [F|Args], Out]) :-
    Goal =.. [F|ArgsAndOut],
    append(Args, [Out], ArgsAndOut), !.
metta_node_call_node(Goal, [call, Text, '?']) :-
    term_string(Goal, Text).

% A match over a space names the atom it found; anything else names its goal.
metta_node_leaf(_, match(Space, Pattern, _, _), [[fact, Space, Pattern]]) :- !.
metta_node_leaf(Module, Goal, [[fact, Space, Fact]]) :-
    metta_host_native_fact(Module, Goal, Space, Fact), !.
metta_node_leaf(_, Goal, [[fact, '&self', Fact]]) :-
    functor(Goal, Space, _),
    atom_concat('&', _, Space), !,
    Goal =.. [Space|Fact].
metta_node_leaf(_, Goal, [[builtin, Text]]) :- term_string(Goal, Text).

%%%%%%%%%% Spaces implemented in TypeScript %%%%%%%%%%
%
% A space whose atoms live on the host: a Map, an array, a SQL table, an HTTP
% service. The engine's hooks route match, add, remove and get-atoms here; the
% provider enumerates CANDIDATE atoms for a pattern and unification against
% the pattern happens in Prolog, so a provider may over-approximate freely and
% soundness stays the engine's.
%
% The crossing is the same trampoline a host operation uses, so nothing new is
% invented for it: one yield per call, and a stream for the two enumerating
% verbs. The names begin with `$` so MeTTa source cannot spell them, and they
% are NOT registered as engine functions, because a provider is a space rather
% than an operation.

:- multifile seam:foreign_space/1.
:- multifile seam:foreign_match/3.
:- multifile seam:foreign_add/2.
:- multifile seam:foreign_remove/3.
:- multifile seam:foreign_atoms/2.
:- multifile seam:foreign_clear/1.
:- multifile seam:foreign_add_many/2.
:- multifile seam:foreign_pushdown/3.
:- multifile seam:foreign_plan/5.
:- multifile seam:foreign_begin/1.
:- multifile seam:foreign_commit/1.
:- multifile seam:foreign_rollback/1.
:- multifile seam:foreign_capability/2.
:- multifile seam:foreign_refuse/2.

:- dynamic metta_node_foreign/1.
:- dynamic metta_node_capability/2.

% The ownership seam carries NO clause from this file, and registration
% asserts one.
%
% seam:foreign_space/1 is consulted by the matcher, the type resolvers, the
% translator and the codec on every space operation. A clause that is always
% present and always fails still costs its own frame, and that frame is paid by
% every program whether or not it has a provider: 500 inferences over the
% define-call benchmark's five hundred calls, exactly one per call, 0.21
% percent, for a capability the benchmark does not use [measured 2026-08-28:
% 239005 with the clause against 238505 without it, minimum of three runs each,
% every other section of this file held constant; command=sh
% extensions/node/bench.sh]. Asserting the NAME instead means the predicate has
% a clause exactly while a provider exists, the name is first-argument indexed,
% and a build with no provider pays nothing at all.
%
% The declaration is guarded because the predicate is multifile: another seat
% may have contributed a STATIC clause to it first, which is what the
% repository's own combined static-check load does when it consults all three
% transports together. There, the declaration is a no-op and registration
% refuses by name rather than claiming a space the engine would never route
% here. That configuration SCANS this file and never registers anything, so the
% refusal is a guard against a silent half-registration rather than a path
% anything takes.
%
% One consequence to state, because a gate depends on it: this file writes no
% seam:foreign_space/1 clause HEAD, so the source reading in
% tests/prolog/static_checks.pl sees none from this seat. The ampersand rule
% that reading enforces is enforced here instead, at the door, by
% metta_node_require_space_name/1 -- which is the same place the Python seat
% enforces it, and what that check's own comment names as the alternative.
:- catch(dynamic(seam:foreign_space/1), _, true).

metta_node_claim_owned(Space) :-
    (   seam:foreign_space(Space)
    ->  true
    ;   catch(assertz(seam:foreign_space(Space)), Error,
              throw(error(metta_node_ownership_unavailable(Error),
                          context(metta_node_claim_owned/1,
                                  'seam:foreign_space/1 is static in this \c
                                   configuration, so this seat cannot own a \c
                                   space here'))))
    ).

metta_node_disclaim_owned(Space) :-
    catch(retractall(seam:foreign_space(Space)), _, true).

:- multifile prolog:error_message//1.
prolog:error_message(metta_node_ownership_unavailable(_)) -->
    [ 'a space cannot be backed from the host in this configuration: another \c
       seat has already made seam:foreign_space/1 static'-[] ].

% The five verbs below guard on this seat's own registry, so another seat's
% foreign space falls through to its own contribution rather than being claimed
% here.
seam:foreign_capability(Space, Capability) :-
    metta_node_foreign(Space),
    metta_node_capability(Space, Capability).

% The refusal, handed back to the side that has the words. A provider that
% implements a capability and declines it reads differently from one that does
% not have it, and only the host knows which.
seam:foreign_refuse(Space, Capability) :-
    metta_node_foreign(Space),
    metta_node_provider_call(Space, refuse, [Capability], _).

% The caller's bound rides the call for a provider that declared it can use
% one, and is withheld from one that did not. A bound is ADVISORY and honouring
% it is only sound where an exact match is distinguishable from a candidate:
% truncating an over-approximated candidate list at N would drop true answers
% past the cut, so a provider that claimed nothing is never told the number.
seam:foreign_match(Space, Pattern, Options) :-
    metta_node_foreign(Space),
    (   metta_node_capability(Space, bounded),
        memberchk(limit(Limit), Options)
    ->  metta_node_provider_stream(Space, 'match-bounded', [Pattern, Limit], Candidate)
    ;   metta_node_provider_stream(Space, match, [Pattern], Candidate)
    ),
    Pattern = Candidate.

seam:foreign_atoms(Space, Atom) :-
    metta_node_foreign(Space),
    metta_node_provider_stream(Space, atoms, [], Atom).

% The BULK door. A provider that has one takes the whole batch in one crossing;
% one that does not declares no add-many capability and the engine falls back
% to one seam:foreign_add/2 per atom, which is what every provider written
% before this does.
seam:foreign_add_many(Space, Terms) :-
    metta_node_foreign(Space),
    metta_node_capability(Space, 'add-many'),
    metta_node_provider_call(Space, 'add-many', [Terms], _).

% What the provider claims about its own filtering for this pattern, asked
% only where there is a bound to act on, so an unbounded match pays for no
% crossing it gains nothing from. A provider with no classifier answers
% inexact, which is what every provider written before this says.
seam:foreign_pushdown(Space, Pattern, Class) :-
    metta_node_foreign(Space),
    metta_node_capability(Space, pushdown),
    metta_node_provider_call(Space, pushdown, [Pattern], Answer),
    metta_node_atom(Answer, Class).

% A whole CONJUNCTION, offered before the engine splits it, so a backend's own
% join is reachable. Declining is the default and costs a provider nothing: one
% with no plan method declares no plan capability, this fails, and the engine
% plans the conjunction exactly as it does today.
%
% The claim crosses as POSITIONS rather than as patterns, which is where this
% seat differs from the Python one and why it is simpler. A pattern encoded to
% the host and decoded back is a COPY, so a variable shared across two patterns
% -- every join variable -- would split into two and the claim would silently
% lose answers; Python matches each returned wire against the wire it sent to
% undo that. Positions never leave the engine, so the partition is exact by
% construction: Claimed is what the host named, Rest is everything else, and a
% claim can neither drop a conjunct nor name a pattern nobody offered.
seam:foreign_plan(Space, Patterns, Claimed, Rest, metta_node_plan_rows(Claimed, Rows)) :-
    metta_node_foreign(Space),
    metta_node_capability(Space, plan),
    metta_node_provider_call(Space, plan, [Patterns], Answer),
    Answer \== false,
    Answer = [plan, Indices | Rows],
    metta_node_plan_partition(Indices, Patterns, Claimed, Rest).

% The two halves of the partition, from the positions the host named. The host
% has already checked that each is an integer in range and named once, where
% the provider that produced it could be named in the refusal.
%
% Selection is RECURSIVE and not findall/3, which copies its template: the
% caller's own pattern terms have to reach Claimed unchanged, because a
% variable shared across two patterns -- every join variable -- would otherwise
% split into two copies and the claim would answer nothing. That is the same
% identity the seam's Python side has to restore by wire matching, and losing
% it here cost a diagnosis: the claim was made, the rows were right, and the
% query answered empty [tested: "claims a whole conjunction and answers its own
% join"].
metta_node_plan_partition(Indices, Patterns, Claimed, Rest) :-
    metta_node_plan_take(Indices, Patterns, Claimed),
    metta_node_plan_drop(0, Patterns, Indices, Rest).

metta_node_plan_take([], _, []).
metta_node_plan_take([I|Is], Patterns, [P|Ps]) :-
    nth0(I, Patterns, P),
    metta_node_plan_take(Is, Patterns, Ps).

metta_node_plan_drop(_, [], _, []).
metta_node_plan_drop(At, [P|Ps], Indices, Rest) :-
    Next is At + 1,
    (   memberchk(At, Indices)
    ->  Rest = Kept
    ;   Rest = [P|Kept]
    ),
    metta_node_plan_drop(Next, Ps, Indices, Kept).

% One solution per row, the claimed patterns UNIFIED with it rather than
% trusted. A row of the wrong shape fails here instead of binding something
% odd, and the bindings for the patterns' own variables apply directly.
metta_node_plan_rows(Claimed, Rows) :-
    member(Row, Rows),
    Claimed = Row.

% Transactional participation, driven by (writes Ctx transactional): the
% provider's own begin, commit and rollback.
seam:foreign_begin(Space) :-
    metta_node_foreign(Space),
    metta_node_capability(Space, transactional),
    metta_node_provider_call(Space, begin, [], _).
seam:foreign_commit(Space) :-
    metta_node_foreign(Space),
    metta_node_capability(Space, transactional),
    metta_node_provider_call(Space, commit, [], _).
seam:foreign_rollback(Space) :-
    metta_node_foreign(Space),
    metta_node_capability(Space, transactional),
    metta_node_provider_call(Space, rollback, [], _).

seam:foreign_add(Space, Term) :-
    metta_node_foreign(Space),
    metta_node_provider_call(Space, add, [Term], _).

seam:foreign_remove(Space, Term, Removed) :-
    metta_node_foreign(Space),
    metta_node_provider_call(Space, remove, [Term], Answer),
    ( Answer == false -> Removed = false ; Removed = true ).

seam:foreign_clear(Space) :-
    metta_node_foreign(Space),
    metta_node_provider_call(Space, clear, [], _).

% The two crossings, over the operation trampoline. `$provider-call` answers
% once and `$provider-stream` answers as often as the host has answers, which
% is exactly the det and many shapes a registered operation already has.
metta_node_provider_call(Space, Verb, Args, Result) :-
    metta_node_ask('$provider-call', [Space, Verb | Args], Reply, Names),
    metta_node_det_reply(Reply, Names, Result).

metta_node_provider_stream(Space, Verb, Args, Result) :-
    metta_node_ask('$provider-stream', [Space, Verb | Args], Reply, Names),
    metta_node_many_reply(Reply, Names, Result).

% A provider's event promise, written as the ordinary (events ...) declaration
% so a MeTTa program reads what the engine acts on. It rides registration
% rather than a second crossing because the two are one fact about one space:
% a re-registration that stops promising events must stop the space being
% subscribable in the same step.
metta_node_declare_delivery(Space, Delivery0) :-
    metta_host_remove_reported('&metta', [events, Space, _, _], _),
    (   Delivery0 = [D0, O0]
    ->  metta_node_atom(D0, D),
        metta_node_atom(O0, O),
        metta_add_atoms('&metta', [[events, Space, D, O]])
    ;   true
    ).

% A provider may name a space the engine's own creation doors would have
% refused, because seam:foreign_space/1 is an open ownership seam. The
% consequence is not an error but silence: the matcher, get-metatype, the type
% resolvers, operation admission, the translator and the codec would all
% quietly answer that the name is no space. So this door refuses instead.
metta_node_require_space_name(Space) :-
    (   atom(Space), atom_concat('&', _, Space)
    ->  true
    ;   throw(error(metta_node_bad_space_name(Space),
                    context(metta_node_require_space_name/1,
                            'a space name begins with an ampersand')))
    ).

:- multifile prolog:error_message//1.
prolog:error_message(metta_node_bad_space_name(Name)) -->
    [ 'a space implemented on the host must be named with a leading \c
       ampersand, and ~w is not'-[Name] ].

%%%%%%%%%% A space's content as one hash %%%%%%%%%%

metta_node_digest_result(digest(Hash0), _, Hash) :- !, atom_string(Hash0, Hash).
metta_node_digest_result(object(Atom), Space, _) :-
    !,
    throw(error(metta_node_undigestable(Space, 'a live host object', Atom),
                context(metta_node_command/3, 'a digest is content, and a reference is not'))).
% This seat's handles are ATOMS of a reserved shape rather than blobs, so the
% engine's object probe does not claim them and its unwritable-symbol check
% catches them second. The refusal is right either way; naming the reason
% precisely is the difference between a message a reader can act on and one
% that sends them looking for a symbol they never wrote.
metta_node_digest_result(symbol(Bad), Space, _) :-
    metta_node_object_id(Bad, _),
    !,
    throw(error(metta_node_undigestable(Space, 'a live host object', Bad),
                context(metta_node_command/3, 'a digest is content, and a reference is not'))).
metta_node_digest_result(symbol(Bad), Space, _) :-
    throw(error(metta_node_undigestable(Space, 'a symbol nothing can write', Bad),
                context(metta_node_command/3, 'a digest is content, and a reference is not'))).

:- multifile prolog:error_message//1.
prolog:error_message(metta_node_undigestable(Space, What, Term)) -->
    [ '~w holds ~w (~p), so its content has no digest that means anything in \c
       another process'-[Space, What, Term] ].

%%%%%%%%%% Reader classes the host constructs %%%%%%%%%%
%
% The seam carries no clause until a token is registered, for the reason
% seam:foreign_space/1 and seam:matchable_value/1 carry none: the reader
% consults it per candidate lexeme, and a clause that is always present and
% always fails is a frame every parse pays for a door almost no program opens.
:- multifile seam:host_reader_token_construct/3.
:- dynamic seam:host_reader_token_construct/3.
:- dynamic metta_node_token_on/0.

metta_node_token_enable :-
    (   metta_node_token_on
    ->  true
    ;   assertz(metta_node_token_on),
        assertz((seam:host_reader_token_construct(Key, Text, Term) :-
                    metta_node_token_construct(Key, Text, Term)))
    ).

% The lexeme crosses whole, quotes included for a string token, and the host
% answers the term the reader returns.
metta_node_token_construct(Key, Text, Term) :-
    metta_node_ask('$token-construct', [Key, Text], Reply, Names),
    metta_node_det_reply(Reply, Names, Term).

%%%%%%%%%% Custom matching for host values %%%%%%%%%%
%
% Hyperon's CustomMatch: a host value may own its matching, consulted by
% metta_match_atoms/2 when it meets a non-variable operand inside `unify`.
% A variable still binds the value whole without consulting it, so a value
% that owns its matching is still an ordinary value everywhere else.
%
% The seam carries NO clause from this file, and registration asserts one.
% seam:matchable_value/1 sits on the matcher's ground-comparison path, which is
% the hottest path there is, so a clause that is always present and always
% fails would charge every program a frame per comparison for a capability
% almost none of them use. This is the same measurement that keeps
% seam:foreign_space/1 clauseless until a provider registers
% [measured 2026-08-28: 500 inferences over define-call's five hundred calls
% for the analogous always-present clause, one per call].
%
% The probe MEMOISES per object id. A value's class does not change and an id
% is minted once per object, so the first comparison against a given id asks
% the host and every later one is an indexed lookup; without the memo a match
% over a space of N atoms would cost N crossings. A registration invalidates
% the negative half of the memo, because a value that crossed before its class
% was registered was correctly recorded as not matchable and is now.
:- multifile seam:matchable_value/1.
:- multifile seam:custom_match/2.
% Dynamic as well as multifile, because the clauses arrive at REGISTRATION
% rather than at load: the engine declares both static-multifile, which is what
% a host adding its clauses in a consulted file needs, and this seat adds and
% removes them while running. Declaring them dynamic adds no clause, so a
% program that never registers still reaches a predicate with none.
:- dynamic seam:matchable_value/1.
:- dynamic seam:custom_match/2.
:- dynamic metta_node_matchable/2.
:- dynamic metta_node_custom_match_on/0.

metta_node_custom_match_enable :-
    retractall(metta_node_matchable(_, false)),
    (   metta_node_custom_match_on
    ->  true
    ;   assertz(metta_node_custom_match_on),
        assertz((seam:matchable_value(T) :- metta_node_matchable_object(T))),
        assertz((seam:custom_match(T, Other) :- metta_node_custom_match(T, Other)))
    ).

metta_node_custom_match_disable :-
    (   retract(metta_node_custom_match_on)
    ->  retractall(seam:matchable_value(_)),
        retractall(seam:custom_match(_, _)),
        retractall(metta_node_matchable(_, _))
    ;   true
    ).

metta_node_matchable_object(Term) :-
    metta_node_object_id(Term, Id),
    (   metta_node_matchable(Id, Known)
    ->  Known == true
    ;   metta_node_ask('$matchable', [Term], Reply, Names),
        metta_node_det_reply(Reply, Names, Answer),
        (   Answer == false
        ->  assertz(metta_node_matchable(Id, false)),
            fail
        ;   assertz(metta_node_matchable(Id, true))
        )
    ).

% The value is local to the host, so nothing crosses per candidate: its own
% matching runs there and only the answers come back, each held to the operand
% it met exactly as a provider's candidates are.
metta_node_custom_match(Term, Other) :-
    metta_node_ask('$custom-match', [Term, Other], Reply, Names),
    metta_node_many_reply(Reply, Names, Candidate),
    Other = Candidate.

%%%%%%%%%% The engine's own counters %%%%%%%%%%
%
% Read OUTSIDE a job, deliberately. SWI's inference counter is per ENGINE, so
% a reading taken inside a job's own engine reports that engine's handful
% rather than the process's work; the same is true of the garbage-collection
% triple. Every value crosses as its canonical text, so a counter past the
% signed-i64 boundary is exact rather than rounded.
metta_node_counters(Texts) :-
    statistics(inferences, Inferences),
    statistics(cputime, CpuTime),
    statistics(garbage_collection, [GcCount, GcFreed, GcTimeMs|_]),
    statistics(table_space_used, TableBytes),
    maplist(metta_node_number_text,
            [Inferences, CpuTime, GcCount, GcFreed, GcTimeMs, TableBytes],
            Texts).
