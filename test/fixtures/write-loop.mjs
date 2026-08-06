/**
 * Child process for the SIGKILL torture test (acceptance #3).
 *
 * Writes two known-good payloads alternately, as fast as it can, until it is
 * killed. Whatever moment the kill lands, the target file must contain one
 * complete payload or the other — never a partial write.
 *
 * Run as: node write-loop.mjs <distWritePath> <targetPath>
 */
const [, , distWritePath, targetPath] = process.argv;

const { atomicWriteFile, serializeJson } = await import(distWritePath);

// Large enough that a write is not instantaneous, so SIGKILL can land inside one.
const filler = (ch) => ch.repeat(120_000);
const payloads = [
  serializeJson({ version: 1, permissions: { allow: ["Bash(ls)"] }, filler: filler("a") }),
  serializeJson({ version: 2, permissions: { allow: ["Bash(git diff *)"] }, filler: filler("b") }),
];

process.send?.("ready");

let i = 0;
// eslint-disable-next-line no-constant-condition
while (true) {
  atomicWriteFile(targetPath, payloads[i % 2]);
  i += 1;
}
