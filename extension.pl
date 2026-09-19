% This seat's control file; see extensions/python/extension.pl for the model.
%
% No entry(engine, _): the engine never loads this seat. It runs the OTHER way
% around -- engine.ts boots a WebAssembly SWI, mounts the engine tree into it,
% and consults the transport itself -- so this seat had no decider at all and
% was invisible to everything that enumerates seats. The control file is what
% gives it a first-class identity: the transport is recorded here for the
% tooling that derives the transport list, and `metta list` can say the seat
% exists without node ever being installed.

title('MeTTa in TypeScript: the engine on swipl-wasm inside Node').
entry(host, 'bridge.pl').
