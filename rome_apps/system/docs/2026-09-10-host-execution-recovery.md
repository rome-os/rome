# Host execution recovery

Root script actions accept the routine engine's reserved trigger field and strip
it before calling Core. The helper receives only the validated script request.

If an action worker disappears after submission, the main runtime reports the
original host job identities. Routine dispatch records that uncertain outcome
without scheduling another execution. This includes host jobs submitted by
nested actions whose parent worker exits before returning its result.

Validation exercises the real main and worker action engines with the host
client over a Unix socket. The regression submits one job, loses the worker
result, and checks that the caller receives its lookup ID without a second
submission. A routine regression covers reserved trigger input and retry policy.
