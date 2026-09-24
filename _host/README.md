<!-- Purpose: say what the files beside this one are and where they come from.
Written by tools/wasm-host/build.sh vendor in MesTTo/MeTTa; rerun it rather than editing this. -->
# The WebAssembly SWI-Prolog this package runs on

`swipl-web.cjs` (emscripten's loader), `swipl-web.wasm` and `swipl-web.data`
are one link of SWI-Prolog 10.1.14, swipl-devel commit
69775434c8226897626b226aefcc8266499f1e2e, with every patch in MesTTo/MeTTa's
`tests/checks/host_workarounds/` applied. They were compiled by
npm-swipl-wasm's own Docker recipe at commit 774c700f2bae5c3f59706ad11dbfbd6d5f8af3e1, with
emsdk 6.0.9, zlib 1.3.2 and pcre2-10.48, and report `compiled_at` Sep 24 2026, 06:12:34.

Beyond that recipe the build links SWI's archive, utf8proc and yaml packages
and clib's uuid binding over libarchive (MesTTo/MeTTa-Library-Pack's pinned
lib_compression snapshot), utf8proc 2.10.0, libyaml 0.2.5 and OSSP UUID
1.6.2, and the native half of every library
in that pack carrying `support/static.cmake`, which the library activates by
name here where a native host loads a shared object. It also links
emscripten's NODEFS, so under Node a program can mount a host directory into
the host's file system through `FS.filesystems.NODEFS`; a browser never
takes that path. Its memory can grow to 4 GiB, all a 32-bit memory
addresses, where emscripten's default maximum is 2 GiB.

The data image holds SWI's library and, at /swipl/metta-host.pl, the
declaration of the patches this build carries, which the engine checks at every
boot. Rebuild with `sh tools/wasm-host/build.sh && sh tools/wasm-host/build.sh
vendor` in MesTTo/MeTTa. SWI-Prolog's licence is `LICENSE` beside this file.
