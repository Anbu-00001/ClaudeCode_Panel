import { Text, useStdout } from "ink";
import React, { useEffect, useState } from "react";
import { detectLadderState, type LadderState } from "./core/detect.js";
import { Ladder } from "./screens/Ladder.js";

type Screen = "ladder";

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  });

  useEffect(() => {
    function onResize() {
      setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    }
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

/** Screen router. Only Ladder exists in M1 — the switch is here so later
 * milestones add cases instead of restructuring. */
export function App() {
  const { columns, rows } = useTerminalSize();
  const [screen] = useState<Screen>("ladder");
  const [state] = useState<LadderState>(() => detectLadderState());

  if (columns < 80 || rows < 24) {
    return <Text>ccpanel needs a window at least 80 columns wide.</Text>;
  }

  switch (screen) {
    case "ladder":
    default:
      return <Ladder state={state} />;
  }
}
