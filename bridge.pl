% Purpose: the Prolog half of the Node binding's transport. It runs a MeTTa
%   program, holds one query open as a resumable answer stream, and speaks the
%   seven-tag codec the other bindings speak, so a JavaScript host can embed
%   the engine in its own process.
% Assumes:
%   - every engine predicate called here carries an seam:kind/2 in
%     engine/ext_points.pl, service or host_service, or is a MeTTa builtin that
%     builtin_fun/1 already enumerates [tested: tests/prolog/static_checks.pl,
%     a_host_binding_calls_only_published_surface]
%   - engine_create/3 and engine_next/2 exist in the host SWI, including the
%     WebAssembly build [measured 2026-08-20: swipl-wasm 8.0.6, SWI 100113,
%     an engine held across separate host calls with unrelated calls in
%     between resumed correctly]
%   - the transport carries a number as its canonical Prolog text, because
%     the WebAssembly value conversion renders the float 2.0 as the
%     JavaScript number 2, which is also what the integer 2 renders as, and
%     MeTTa tells the two apart [measured 2026-08-20: (== 2 2.0) answers
%     False, and both terms crossed as the JavaScript number 2]
% Guarantees:
%   - petta_node_next/2 computes at most one answer per call, so a host that
%     stops pulling leaves the rest of an infinite stream uncomputed
%     [tested: test_the_node_binding_leaves_the_third_answer_uncomputed]
%   - a term the codec has no tag for raises rather than crossing as text
%   - petta_node_close/1 is idempotent
%   - no Prolog exception reaches the host: every call arrives through
%     petta_node_do/2 and the outcome crosses as data
%     [tested: the node --test suite, "raises an error rather than printing it"]
%   - signed-i64 Number values and wider BigInt values cross as exact decimal
%     text in both directions [tested: the node --test suite,
%     "carries Number and BigInt across the signed-i64 boundary"]
%   - runnable free variables retain source names in their wire value and host
%     text [tested: test_the_node_binding_and_the_python_host_answer_the_same_programs;
%     commit=916def0562c211143bb91cd0bd8b2c9dac7ab4fa]
% Owns: one SWI engine per open cursor, released by petta_node_close/1, which
%   the JavaScript iterator calls from its own return() so an abandoned
%   for-await releases it.
% Decides: a Prolog integer crosses as decimal text and a float as its ~q
%   spelling. The JavaScript side reads every integer as a BigInt and every
%   float as a number. The integer value determines its MeTTa Number or BigInt
%   type after it crosses.
% Open Obligations:
%   To Do: None
%   Hacks: None
%   Future Enhancements: None

:- dynamic petta_node_cursor/2.
:- dynamic petta_node_captured/1.

%%%%%%%%%% Every call from the host comes through here %%%%%%%%%%
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
petta_node_do(Goal, Outcome) :-
    catch(( call(Goal) -> Outcome = [ok] ; Outcome = [fail] ),
          Ball,
          ( petta_node_render(Ball, Text), Outcome = [error, Text] )).

% The message is SWI's own: print_message/2 renders it through exactly the
% machinery the console would have used, and the hook below takes the lines
% instead of letting them out. Only ONE message is emitted inside the guarded
% window, so nothing else is caught by it.
petta_node_render(Ball, Text) :-
    retractall(petta_node_captured(_)),
    setup_call_cleanup(nb_setval('$petta_node_capture', true),
                       catch(print_message(error, Ball), _, true),
                       nb_setval('$petta_node_capture', false)),
    (   petta_node_captured(Rendered)
    ->  Text = Rendered
    ;   term_string(Ball, Text)
    ),
    retractall(petta_node_captured(_)).

% Deaf outside petta_node_render/2, and it has to be: a hook that succeeds
% suppresses the message, so an always-on one would swallow the loader's own
% diagnostics. It is module-qualified because message_hook/3 is SWI's
% protocol and not a seam of this engine's.
:- multifile user:message_hook/3.
user:message_hook(_, _, Lines) :-
    nb_current('$petta_node_capture', true),
    print_message_lines(atom(Text), '', Lines),
    assertz(petta_node_captured(Text)).

%%%%%%%%%% The seven-tag codec %%%%%%%%%%
%
% The same tags bindings/python/petta/shim.pl's petta_py_encode/2 writes and
% bindings/python/petta/_atom_wire.py reads: s symbol, v variable, n number, g string,
% b boolean, e expression. Two tags that codec has are refused here rather
% than faked. `o` is a live host object and no JavaScript object is ever
% inside this engine, and `h` is a native blob, whose whole point is an
% identity a registry hands back; a binding that stringified either would
% hand its caller something that cannot go home again.
%
% The number payload is TEXT and that is this transport's own decision, not
% the grammar's. Every other payload survives the WebAssembly value
% conversion unchanged; raw swipl-wasm changes from JavaScript Number to
% BigInt at 2^53, while the language changes from Number to BigInt at signed
% i64. Text keeps those independent and preserves the integer/float split. It
% is what the shipped JSON codec already falls back on for the same reason
% (bindings/python/examples/integration/typescript_space/space_server.ts reads the JSON
% source literal rather than the parsed number, so an integer past 2^53 is
% caught instead of silently rounded).
petta_node_encode(T, [v, Name]) :- var(T), !, term_to_atom(T, A), atom_string(A, Name).
petta_node_encode(T, [n, Text]) :- number(T), !, petta_node_number_text(T, Text).
petta_node_encode(T, [g, T])    :- string(T), !.
petta_node_encode(T, [b, T])    :- ( T == true ; T == false ), !.
petta_node_encode(T, [s, S])    :- atom(T), !, atom_string(T, S).
petta_node_encode(T, [e, Es])   :- is_list(T), !, maplist(petta_node_encode, T, Es).
petta_node_encode(T, _) :-
    throw(error(petta_node_untaggable(T),
                context(petta_node_encode/2,
                        'the Node binding has no wire tag for this term'))).

petta_node_encode_named(T, Pairs, [v, Name]) :- var(T), !,
    ( petta_node_var_name(Pairs, T, Written) -> atom_string(Written, Name)
    ; term_to_atom(T, A), atom_string(A, Name) ).
petta_node_encode_named(T, Pairs, [e, Encoded]) :- is_list(T), !,
    maplist(petta_node_encode_with_names(Pairs), T, Encoded).
petta_node_encode_named(T, _, Encoded) :-
    petta_node_encode(T, Encoded).

petta_node_encode_with_names(Pairs, Term, Encoded) :-
    petta_node_encode_named(Term, Pairs, Encoded).

petta_node_var_name([Name-Var|_], Term, Name) :- Var == Term, !.
petta_node_var_name([_|Pairs], Term, Name) :-
    petta_node_var_name(Pairs, Term, Name).

% ~q is the spelling the reader takes back, so 2.0 stays 2.0, a rational stays
% 1r3 and a non-finite float stays inf, -inf or nan. Each of those three is a
% class the engine's own writer already reports as unwritable, and naming them
% at the boundary is what lets the JavaScript side refuse rather than round.
petta_node_number_text(T, Text) :- format(atom(A), '~q', [T]), atom_string(A, Text).

% The inverse. A tag arrives from the host as an atom, and so does every text
% payload, because the WebAssembly conversion has no separate string type on
% the way in. Numbers are read back from their text with the reader, which is
% the only thing that reads every spelling ~q writes.
%
% The names travel with the walk, because a v payload is an IDENTITY WITHIN
% ITS TERM and not a display name: two occurrences of one payload are two
% occurrences of one variable, and (f $x $x) is a different term from
% (f $x $y). Decoding each occurrence fresh made the two the same term, which
% the codec kit's corpus caught on its expression-repeated-variable case
% [measured 2026-08-20].
%
% `_` is the one reserved payload and the exception: fresh at every
% occurrence and never recorded, exactly as $_ is in source, so two of them
% constrain nothing.
petta_node_decode(W, T) :- petta_node_decode(W, [], _, T).

petta_node_decode(W, Names0, Names, T) :-
    (   petta_node_decode_(W, Names0, Names, T)
    ->  true
    ;   throw(error(petta_node_undecodable(W),
                    context(petta_node_decode/2,
                            'not a wire atom the Node binding writes')))
    ).

petta_node_decode_([Tag, Payload], Names, Names, T) :- petta_node_tag(Tag, s), !,
    petta_node_atom(Payload, T).
petta_node_decode_([Tag, Payload], Names, Names, T) :- petta_node_tag(Tag, n), !,
    petta_node_atom(Payload, A),
    petta_node_number(A, T).
petta_node_decode_([Tag, Payload], Names, Names, T) :- petta_node_tag(Tag, g), !,
    petta_node_atom(Payload, A), atom_string(A, T).
petta_node_decode_([Tag, Payload], Names, Names, T) :- petta_node_tag(Tag, b), !,
    petta_node_atom(Payload, T), ( T == true ; T == false ).
petta_node_decode_([Tag, Payload], Names0, Names, T) :- petta_node_tag(Tag, v), !,
    petta_node_atom(Payload, Name),
    (   Name == '_'
    ->  Names = Names0
    ;   memberchk(Name-Known, Names0)
    ->  T = Known, Names = Names0
    ;   Names = [Name-T|Names0]
    ).
petta_node_decode_([Tag, Payload], Names0, Names, T) :- petta_node_tag(Tag, e), !,
    is_list(Payload),
    petta_node_decode_items(Payload, Names0, Names, T).

petta_node_decode_items([], Names, Names, []).
petta_node_decode_items([W|Ws], Names0, Names, [T|Ts]) :-
    petta_node_decode(W, Names0, Names1, T),
    petta_node_decode_items(Ws, Names1, Names, Ts).

% The reader takes back every spelling ~q writes, the non-finite floats
% included: 1.0Inf, -1.0Inf and 1.5NaN all read back as numbers, where the
% MeTTa grammar's own inf, -inf and NaN read as symbols
% [measured 2026-08-20, and the note beside metta_unwritable_symbol/2 in
% engine/ext_points.pl is why the two spellings differ]. So one clause covers
% the whole numeric tower and the JavaScript side writes ~q's spelling.
petta_node_number(A, T) :- term_to_atom(T, A), number(T).

petta_node_tag(Tag, Want) :- petta_node_atom(Tag, Want).

petta_node_atom(In, Out) :- atom(In), !, Out = In.
petta_node_atom(In, Out) :- string(In), !, atom_string(Out, In).
petta_node_atom(In, Out) :- number(In), !, atom_number(Out, In).

% MeTTa source text as one atom, through the engine's own reader. It is the
% leg a whole binding has and a storage provider does not: a store carries
% wire terms and never sees the text they were written as.
petta_node_read(Source, Wire) :-
    petta_node_text(Source, S),
    sread(S, Term),
    petta_node_encode(Term, Wire).

%%%%%%%%%% Running a program %%%%%%%%%%
%
% The grouping walk, the working-dir defaulting and the load lifecycle are
% the engine's host run and load surface (engine/filereader.pl), shared with
% the Python shim; this side maps its own codec over the term groups and
% nothing else. One encoded group per ! directive, in source order.
petta_node_run(Source, Groups) :-
    petta_node_text(Source, S),
    metta_host_run_source(S, '&self', [], TermGroups),
    maplist(petta_node_group, TermGroups, Groups).

petta_node_group(Terms, Encoded) :-
    maplist(petta_node_answer, Terms, Encoded).

% Each answer crosses as its wire form AND the engine's own rendering of it.
% The text is not a convenience, and it is PRESENTATION: the display writer
% is the same authority the command line's answers use, so host-only values
% and non-finite floats render beside their wire forms instead of refusing
% the whole answer. Round-trip storage keeps swrite/2's stricter contract.
petta_node_answer('$petta_answer'(Term, NameState), [Wire, Text]) :- !,
    petta_name_pairs(NameState, Names),
    petta_node_encode_named(Term, Names, Wire),
    sdisplay_with_names(Term, NameState, Text).
petta_node_answer(Term, [Wire, Text]) :-
    petta_node_encode(Term, Wire),
    sdisplay(Term, Text).

% A file, loaded through the same engine door import! uses, so the file is
% recorded under the canonical path both doors key on and a reload replaces
% the first load's definitions rather than doubling them.
petta_node_load(File, Groups) :-
    petta_node_atom(File, FA),
    metta_host_load_file(FA, '&self', TermGroups),
    maplist(petta_node_group, TermGroups, Groups).

%%%%%%%%%% One query, held open %%%%%%%%%%
%
% An SWI engine is a goal suspended between answers: it "can, if asked,
% resume" after yielding one, which is the answer-stream reading Tarau states
% as design law and wraps in the host's own stream abstraction (A Hitchhiker's
% Guide to Reinventing a Prolog Machine, ICLP 2017, sections 4.5 and 5). The
% JavaScript half wraps this pair in an async iterator for the same reason.
%
% The engine handle stays HERE and the host holds an integer. A blob has no
% JavaScript identity to hold: the WebAssembly conversion renders every one of
% them as the same opaque {"$t":"b"} [measured 2026-08-20], so a host that
% kept the handle could not hand it back.
%
% with_metta_module/2 runs INSIDE the engine. An engine has its own stack, so
% the module in force outside it is not in force within, and
% current_metta_module/1 would fall back to &self's however the caller had
% switched it.
petta_node_open(Source, Space, Id) :-
    petta_node_text(Source, S),
    sread(S, Term),
    space_module(Space, Module),
    engine_create(Out, with_metta_module(Module, eval(Term, Out)), Engine),
    petta_node_fresh_id(Id),
    assertz(petta_node_cursor(Id, Engine)).

petta_node_fresh_id(Id) :-
    (   aggregate_all(max(N), petta_node_cursor(N, _), Highest)
    ->  Id is Highest + 1
    ;   Id = 1
    ).

% [] is exhaustion and [Answer] is one answer, so the host needs no sentinel.
% A closed cursor is a caller bug rather than an empty stream, so it raises.
petta_node_next(Id, Answer) :-
    (   petta_node_cursor(Id, Engine)
    ->  true
    ;   throw(error(petta_node_no_cursor(Id),
                    context(petta_node_next/2, 'this cursor is closed')))
    ),
    (   engine_next(Engine, Term)
    ->  petta_node_answer(Term, One), Answer = [One]
    ;   Answer = []
    ).

% Idempotent: a host that closes after exhaustion, and again from an
% abandoned iterator's return(), finds nothing the second time and is at peace.
petta_node_close(Id) :-
    (   retract(petta_node_cursor(Id, Engine))
    ->  catch(engine_destroy(Engine), error(existence_error(_, _), _), true)
    ;   true
    ).

% A JavaScript string arrives as an atom, because the WebAssembly conversion
% has one text type going in where Prolog has two [measured 2026-08-20].
petta_node_text(In, Out) :- string(In), !, Out = In.
petta_node_text(In, Out) :- atom_string(In, Out).
