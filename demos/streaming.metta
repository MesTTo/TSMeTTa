; The program the Node binding's README and tests run.
;
; The first half is an ordinary bounded answer; the second is an unbounded
; generator, which is what the binding's async iterator is for. Nothing here
; is Node's: `superpose` recursing on itself is the generator every MeTTa
; program writes, and ch07-control-flow/07-04-bounded-and-committed-searches/02-metta4_streams.metta writes the bounded form of
; the same shape.

(= (upto $k $n)
   (if (< $k $n)
       (superpose ($k (upto (+ $k 1) $n)))
       (empty)))

!(collapse (upto 1 4))

; The unbounded one. `collapse` cannot run over it and neither can any host
; that computes a directive's answers before handing one over, which is why
; the binding pulls instead.
(= (from $n) (superpose ($n (from (+ $n 1)))))
