// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The home screen's logo: Anthony's own ASCII rendering of the sticker, kept
// exactly as he drew it. Only the shared left margin and trailing spaces are
// trimmed. The globe is the `-` and `.` texture; the script and the screw base
// are the `#` and `+` strokes.

const DRAWN = `
                                   -+----.--.-..--.
                                .------.....-.....-..-
                              -----....................-
                             ---.-.......................
                            --.-...........   . ...........
                           ----..........            ......
                          ----.........               ......
                          ..-...-....                   .....
                         .-.-.-.....                     ....
                         ----.....                      . ..  #       ##
                          ........         .##           .   #+      ##
               ####       -....           ## #              ##     #######
           ###-   ##      -..  ## #      .# #  ##          ##  #    ##
         ###    ##         .  ##         # #       #####  ## ###   ##
        ##.                . ##    ###  ###  ##   #   #. ###  ##  ##
        ####          # ##  #### ##  # ##    #  +#   ## ###  ## .### #
          #####    -#  ##   ##  ###+  ###   ## ### #### ##   ##   ##      #
              ##+ ##  ##  .##  ###   #### ####.  # +##                   ##
              ### #- ### ###   -####              +######################
             ###  ##- ## -## -.                 # ##          .####.
     #     ###           ##  -...-..  .      +#  ##
    ########            ##   ..........      # +##
                        #   ##### ........
                      ####  ##-##  # ....
                     ####  #### ## ##
                    ####  ###+## ### #
                   +##  # #-#########
                     ##  #.### #####
                     ### ##########
                      ############
                        # #######
                          -
`;

function trimmed(drawn: string): string[] {
  const lines = drawn.split("\n").map((line) => line.trimEnd());
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  const margin = Math.min(...lines.filter((line) => line !== "").map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(margin));
}

export const LOGO_ART: readonly string[] = trimmed(DRAWN);
export const LOGO_ART_WIDTH = Math.max(...LOGO_ART.map((line) => line.length));

/** Which part of the logo a character belongs to. */
export type LogoPart = "globe" | "stroke" | "space";

const STROKE = /[#+]/;

/**
 * The globe is the `-` and `.` texture; the script and the base are drawn in
 * `#` and `+`. A `-` or `.` touching a stroke on its row is part of that
 * stroke (the script's joins and the base's threads use them too).
 */
export function logoParts(line: string): LogoPart[] {
  return [...line].map((char, x) => {
    if (char === " ") return "space";
    if (STROKE.test(char)) return "stroke";
    const touches = STROKE.test(line[x - 1] ?? "") || STROKE.test(line[x + 1] ?? "");
    return touches ? "stroke" : "globe";
  });
}

/** One row of the logo, painted by part. Runs of a part share one paint call; spaces stay unpainted. */
export function paintLogoRow(line: string, paint: (part: Exclude<LogoPart, "space">, text: string) => string): string {
  const parts = logoParts(line);
  let out = "";
  let run = "";
  let runPart: LogoPart = "space";
  const flush = (): void => {
    if (run !== "") out += runPart === "space" ? run : paint(runPart, run);
    run = "";
  };
  [...line].forEach((char, x) => {
    if (parts[x] !== runPart) flush();
    runPart = parts[x];
    run += char;
  });
  flush();
  return out;
}
