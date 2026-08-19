% Purpose: the Prolog half of the Node binding's transport. It runs a MeTTa
%   program, holds one query open as a resumable answer stream, and speaks the
%   seven-tag codec the other bindings speak, so a JavaScript host can embed
%   the engine in its own process.
% Assumes:
%   - every engine predicate called here carries an ext_point_kind/2 in
%     src/ext_points.pl, service or host_service, or is a MeTTa builtin that
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
% Owns: one SWI engine per open cursor, released by petta_node_close/1, which
%   the JavaScript iterator calls from its own return() so an abandoned
%   for-await releases it.
% Decides: a MeTTa integer crosses as decimal text and a float as its ~q
%   spelling; the JavaScript side reads the first as a BigInt and the second
%   as a number, which is that language's own exact-integer/float split.
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
    setup_call_cleanup(nb_setval('$petta_node_capture', true),
                       catch(print_message(error, Ball), _, true),
                       nb_setval('$petta_node_capture', false)),
    (   retract(petta_node_captured(Rendered))
    ->  Text = Rendered
    ;   term_string(Ball, Text)
    ).

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
% The same tags python/petta/shim.pl's petta_py_encode/2 writes and
% python/petta/_atom_wire.py reads: s symbol, v variable, n number, g string,
% b boolean, e expression. Two tags that codec has are refused here rather
% than faked. `o` is a live host object and no JavaScript object is ever
% inside this engine, and `h` is a native blob, whose whole point is an
% identity a registry hands back; a binding that stringified either would
% hand its caller something that cannot go home again.
%
% The number payload is TEXT and that is this transport's own decision, not
% the grammar's. Every other payload survives the WebAssembly value
% conversion unchanged; a number does not, because JavaScript has one numeric
% type where Prolog has two, and the conversion picks it. Text is what the
% shipped JSON codec already falls back on for the same reason
% (python/examples/integration/typescript_space/space_server.ts reads the JSON
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

% ~q is the spelling the reader takes back, so 2.0 stays 2.0, a rational stays
% 1r3 and a non-finite float stays inf, -inf or nan. Each of those three is a
% class the engine's own writer already reports as unwritable, and naming them
% at the boundary is what lets the JavaScript side refuse rather than round.
petta_node_number_text(T, Text) :- format(atom(A), '~q', [T]), atom_string(A, Text).

% The inverse. A tag arrives from the host as an atom, and so does every text
% payload, because the WebAssembly conversion has no separate string type on
% the way in. Numbers are read back from their text with the reader, which is
% the only thing that reads every spelling ~q writes.
petta_node_decode(W, T) :- petta_node_decode_(W, T), !.
petta_node_decode(W, _) :-
    throw(error(petta_node_undecodable(W),
                context(petta_node_decode/2,
                        'not a wire atom the Node binding writes'))).

petta_node_decode_([Tag, Payload], T) :- petta_node_tag(Tag, s), !, petta_node_atom(Payload, T).
petta_node_decode_([Tag, Payload], T) :- petta_node_tag(Tag, n), !,
    petta_node_atom(Payload, A),
    petta_node_number(A, T).
petta_node_decode_([Tag, Payload], T) :- petta_node_tag(Tag, g), !,
    petta_node_atom(Payload, A), atom_string(A, T).
petta_node_decode_([Tag, Payload], T) :- petta_node_tag(Tag, b), !,
    petta_node_atom(Payload, T), ( T == true ; T == false ).
petta_node_decode_([Tag, Payload], T) :- petta_node_tag(Tag, e), !,
    is_list(Payload), maplist(petta_node_decode, Payload, T).

% A variable decodes to a fresh one: its wire name is the writer's _G123 and
% carries no identity a reader could honour, which is the same reading
% python/petta/_atom_wire.py takes.
petta_node_decode_([Tag, _], _) :- petta_node_tag(Tag, v).

% The reader takes back every spelling ~q writes, the non-finite floats
% included: 1.0Inf, -1.0Inf and 1.5NaN all read back as numbers, where the
% MeTTa grammar's own inf, -inf and NaN read as symbols
% [measured 2026-08-20, and the note beside metta_unwritable_symbol/2 in
% src/ext_points.pl is why the two spellings differ]. So one clause covers
% the whole numeric tower and the JavaScript side writes ~q's spelling.
petta_node_number(A, T) :- term_to_atom(T, A), number(T).

petta_node_tag(Tag, Want) :- petta_node_atom(Tag, Want).

petta_node_atom(In, Out) :- atom(In), !, Out = In.
petta_node_atom(In, Out) :- string(In), !, atom_string(Out, In).
petta_node_atom(In, Out) :- number(In), !, atom_number(Out, In).

%%%%%%%%%% Running a program %%%%%%%%%%
%
% The engine's own pipeline, in the order python/petta/shim.pl runs it:
% parse_metta_source/2 reads every form, prepare_parsed_forms/1 registers each
% signature before anything runs so a ! may name a function defined lower
% down, and process_form/3 then runs the forms in source order. One encoded
% group per ! directive, in source order, which is the grouping the Python
% surface reports and the Node one keeps.
petta_node_run(Source, Groups) :-
    petta_node_text(Source, S),
    petta_node_working_dir,
    parse_metta_source(S, Parsed),
    prepare_parsed_forms(Parsed),
    petta_node_forms(Parsed, '&self', Groups), !.

petta_node_forms([], _, []).
petta_node_forms([P|Ps], Space, Out) :-
    process_form(Space, P, Results),
    (   P = parsed(runnable, _, _)
    ->  maplist(petta_node_answer, Results, Encoded),
        Out = [Encoded|Rest]
    ;   Out = Rest
    ),
    petta_node_forms(Ps, Space, Rest).

% Each answer crosses as its wire form AND the engine's own rendering of it.
% The text is not a convenience: swrite/2 is the published writer and the only
% authority on how an atom spells, so a binding that printed answers itself
% would be a second authority that can disagree with the first.
petta_node_answer(Term, [Wire, Text]) :-
    petta_node_encode(Term, Wire),
    swrite(Term, Text).

% import! reads working_dir/1 unconditionally, and a source string has no file
% to take one from, so the process's own directory stands in, exactly as the
% Python transport does it.
petta_node_working_dir :-
    (   catch_recover(working_dir(_), fail)
    ->  true
    ;   working_directory(Dir, Dir),
        assertz(working_dir(Dir))
    ).

% A file, loaded through the same door the engine's own import! uses, so the
% file is recorded under the canonical path both doors key on and a reload
% replaces the first load's definitions rather than doubling them.
petta_node_load(File, Groups) :-
    petta_node_atom(File, FA),
    absolute_file_name(FA, CanonPath, [access(read)]),
    file_directory_name(CanonPath, Dir),
    catch_recover(findall(W, working_dir(W), Saved), Saved = []),
    setup_call_cleanup(
        ( retractall(working_dir(_)), assertz(working_dir(Dir)) ),
        import_when(true, '&self', CanonPath,
            replacing_previous_load(CanonPath, '&self',
                load_imported_metta_file_impl(CanonPath, _),
                with_source_load(CanonPath, '&self',
                    ( read_metta_source(CanonPath, S),
                      petta_node_run(S, Groups) )))),
        ( retractall(working_dir(_)),
          forall(member(W, Saved), assertz(working_dir(W))) )).

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
