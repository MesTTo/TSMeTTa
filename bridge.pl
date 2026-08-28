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
%     the two are DIFFERENT ATOMS [measured 2026-08-27: (=alpha 2 2.0) is
%     False, (case 2 ((2.0 float) ($_ other))) answers other, and
%     (subtraction-atom (2 2.0) (2)) answers (2.0)]. The header here used to
%     cite (== 2 2.0) answering False; it answers True, and engine/metta/
%     operators.pl says why: numeric equality is by VALUE across the
%     integer/float constructors, following LeaTTa's Ground.equiv. Equality
%     promotes, identity does not, and a codec has to preserve identity.
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
metta_node_encode(T, [v, Name]) :- var(T), !, term_to_atom(T, A), atom_string(A, Name).
metta_node_encode(T, [o, Text]) :- metta_node_object_id(T, Id), !, number_string(Id, Text).
metta_node_encode(T, [n, Text]) :- number(T), !, metta_node_number_text(T, Text).
metta_node_encode(T, [g, T])    :- string(T), !.
metta_node_encode(T, [b, T])    :- ( T == true ; T == false ), !.
metta_node_encode(T, [p, S]) :- atom(T), metta_space_operand(T), !, atom_string(T, S).
metta_node_encode(T, [s, S])    :- atom(T), !, atom_string(T, S).
metta_node_encode(T, [e, Es])   :- is_list(T), !, maplist(metta_node_encode, T, Es).
metta_node_encode(T, _) :-
    throw(error(metta_node_untaggable(T),
                context(metta_node_encode/2,
                        'the Node binding has no wire tag for this term'))).

metta_node_encode_named(T, Pairs, [v, Name]) :- var(T), !,
    ( metta_node_var_name(Pairs, T, Written) -> atom_string(Written, Name)
    ; term_to_atom(T, A), atom_string(A, Name) ).
metta_node_encode_named(T, Pairs, [e, Encoded]) :- is_list(T), !,
    maplist(metta_node_encode_with_names(Pairs), T, Encoded).
metta_node_encode_named(T, _, Encoded) :-
    metta_node_encode(T, Encoded).

metta_node_encode_with_names(Pairs, Term, Encoded) :-
    metta_node_encode_named(Term, Pairs, Encoded).

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

metta_node_decode(W, Names0, Names, T) :-
    (   metta_node_decode_(W, Names0, Names, T)
    ->  true
    ;   throw(error(metta_node_undecodable(W),
                    context(metta_node_decode/2,
                            'not a wire atom the Node binding writes')))
    ).

metta_node_decode_([Tag, Payload], Names, Names, T) :- metta_node_tag(Tag, s), !,
    metta_node_atom(Payload, T).
metta_node_decode_([Tag, Payload], Names, Names, T) :- metta_node_tag(Tag, n), !,
    metta_node_atom(Payload, A),
    metta_node_number(A, T).
metta_node_decode_([Tag, Payload], Names, Names, T) :- metta_node_tag(Tag, g), !,
    metta_node_atom(Payload, A), atom_string(A, T).
metta_node_decode_([Tag, Payload], Names, Names, T) :- metta_node_tag(Tag, b), !,
    metta_node_atom(Payload, T), ( T == true ; T == false ).
metta_node_decode_([Tag, Payload], Names, Names, T) :- metta_node_tag(Tag, p), !,
    metta_node_atom(Payload, T), sub_atom(T, 0, 1, _, '&').
metta_node_decode_([Tag, Payload], Names, Names, T) :- metta_node_tag(Tag, o), !,
    metta_node_atom(Payload, A),
    atom_number(A, Id),
    integer(Id),
    metta_node_object_atom(Id, T).
metta_node_decode_([Tag, Payload], Names0, Names, T) :- metta_node_tag(Tag, v), !,
    metta_node_atom(Payload, Name),
    (   Name == '_'
    ->  Names = Names0
    ;   memberchk(Name-Known, Names0)
    ->  T = Known, Names = Names0
    ;   Names = [Name-T|Names0]
    ).
metta_node_decode_([Tag, Payload], Names0, Names, T) :- metta_node_tag(Tag, e), !,
    is_list(Payload),
    metta_node_decode_items(Payload, Names0, Names, T).

metta_node_decode_items([], Names, Names, []).
metta_node_decode_items([W|Ws], Names0, Names, [T|Ts]) :-
    metta_node_decode(W, Names0, Names1, T),
    metta_node_decode_items(Ws, Names1, Names, Ts).

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
metta_node_answer('$metta_answer'(Term, NameState), [Wire, Text]) :- !,
    metta_name_pairs(NameState, Names),
    metta_node_encode_named(Term, Names, Wire),
    sdisplay_with_names(Term, NameState, Text).
metta_node_answer(Term, [Wire, Text]) :-
    metta_node_encode(Term, Wire),
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
                                          watch, unwatch, drain, commit,
                                          platform]).

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

metta_node_command(spacenames, [], [value, [e, Wires]]) :-
    metta_space_names(Names),
    maplist(metta_node_space_wire, Names, Wires).

% The engine's own platform census, which this host READS rather than
% recovering by regex over SWI's stderr. A WebAssembly build has no threads,
% no timers and no processes, and the engine now names each capability it
% lacks and what the absence costs instead of letting three directives fail
% loudly; nothing is printed, so a boot transcript carrying any ERROR: line is
% an unnamed refusal and src/engine.ts refuses it, which is strictly stronger
% than matching against a table this file used to keep in step by hand.
% Every cell crosses as text so the host reads the row without decoding atoms.
metta_node_command(platform, [], [value, [e, Rows]]) :-
    findall([e, [[g, Name], [g, State], [g, Needs], [g, Costs]]],
            ( metta_platform(Capability, Status, Requires, Cost),
              atom_string(Capability, Name),
              atom_string(Status, State),
              term_string(Requires, Needs),
              text_to_string(Cost, Costs) ),
            Rows).

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
    forall(member(R, Removals), metta_host_remove_reported(Parent, R, _)),
    metta_add_atoms(Parent, Added),
    metta_host_clear_space(Child).

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
    metta_node_ask(Name, Args, Reply),
    metta_node_det_reply(Reply, Result).

metta_node_det_reply([ok, Wire], Result) :- !, metta_node_decode(Wire, Result).
metta_node_det_reply([fail], _) :- !, fail.
metta_node_det_reply([error, Text], _) :- !, metta_node_host_throw(Text).
metta_node_det_reply(Reply, _) :-
    throw(error(metta_node_bad_reply(Reply),
                context(metta_node_dispatch_det/3, 'the host answered nothing this side reads'))).

metta_node_dispatch_many(Name, Args, Result) :-
    metta_node_ask(Name, Args, Reply),
    metta_node_many_reply(Reply, Result).

% A host operation that answers a whole set at once sends [many, Wires]; one
% that answers lazily sends [stream] and then one answer per pull, which is
% what an ordinary JavaScript generator or async generator gives without
% being drained first. Backtracking into the disjunction is what asks for the
% next one, so laziness on this side and laziness on that side are one thing.
metta_node_many_reply([many, Wires], Result) :- !,
    member(Wire, Wires),
    metta_node_decode(Wire, Result).
metta_node_many_reply([stream], Result) :- !,
    metta_node_pull(Result).
metta_node_many_reply([fail], _) :- !, fail.
metta_node_many_reply([error, Text], _) :- !, metta_node_host_throw(Text).
metta_node_many_reply(Reply, _) :-
    throw(error(metta_node_bad_reply(Reply),
                context(metta_node_dispatch_many/3, 'the host answered nothing this side reads'))).

% repeat/0 rather than recursion, so the frame count does NOT grow with the
% number of answers pulled. The recursive shape left one choice point and one
% frame per answer and died inside swipl-wasm's own query at about eight
% thousand of them [measured 2026-08-27]; this one is flat, and a host
% operation may answer as long as it likes.
metta_node_pull(Result) :-
    repeat,
    metta_node_yield([pull]),
    engine_fetch(Reply),
    (   Reply = [ok, Wire]
    ->  metta_node_decode(Wire, Result)
    ;   Reply = [done]
    ->  !, fail
    ;   Reply = [error, Text]
    ->  !, metta_node_host_throw(Text)
    ;   !, throw(error(metta_node_bad_reply(Reply),
                       context(metta_node_pull/1,
                               'the host answered nothing this side reads')))
    ).

metta_node_ask(Name, Args, Reply) :-
    maplist(metta_node_encode, Args, Wires),
    metta_node_yield([call, Name, Wires]),
    engine_fetch(Reply).

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
