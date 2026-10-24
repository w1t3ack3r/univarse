// The stack CLIs log progress as it happens, and their results repeat those lines (tests read them there). A CLI that
// printed both showed the owner every line twice; this prints each once.

/** A log that prints each line as it comes, and `unprinted`: the result without the lines already printed (its outcome). */
export function printer(print: (l: string) => void): { log: (l: string) => void; unprinted: <R extends { lines: string[] }>(r: R) => R } {
  let printed = 0;
  return {
    log: (l) => {
      printed += 1;
      print(l);
    },
    unprinted: (r) => ({ ...r, lines: r.lines.slice(printed) }),
  };
}
