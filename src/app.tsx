import { Text, useStdout } from "ink";
import React, { useEffect, useState } from "react";
import { detectLadderState, type LadderState } from "./core/detect.js";
import { type Kit, loadKits } from "./core/kits.js";
import { Commands } from "./screens/Commands.js";
import { Explore } from "./screens/Explore.js";
import { KitDetail } from "./screens/KitDetail.js";
import { Manage } from "./screens/Manage.js";
import { Spending } from "./screens/Spending.js";
import { Kits } from "./screens/Kits.js";
import { Ladder } from "./screens/Ladder.js";

type Screen =
  | { name: "ladder" }
  | { name: "kits" }
  | { name: "kitDetail"; kit: Kit }
  | { name: "explore" }
  | { name: "commands" }
  | { name: "manage" }
  | { name: "spending" };

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

export function App() {
  const { columns, rows } = useTerminalSize();
  const [screen, setScreen] = useState<Screen>({ name: "ladder" });
  const [state, setState] = useState<LadderState>(() => detectLadderState());
  const [kits] = useState<Kit[]>(() => loadKits());

  if (columns < 80 || rows < 24) {
    return <Text>ccpanel needs a window at least 80 columns wide.</Text>;
  }

  /** Installing changes what's on disk, so the ladder is re-read on the way back. */
  function backToKits() {
    setState(detectLadderState());
    setScreen({ name: "kits" });
  }

  switch (screen.name) {
    case "kits":
      return (
        <Kits
          kits={kits}
          repo={state.repo}
          onOpen={(kit) => setScreen({ name: "kitDetail", kit })}
          onBack={() => {
            setState(detectLadderState());
            setScreen({ name: "ladder" });
          }}
        />
      );

    case "kitDetail":
      return <KitDetail kit={screen.kit} repo={state.repo} onBack={backToKits} />;

    case "explore":
      return (
        <Explore
          kits={kits}
          repo={state.repo}
          onOpenKit={(kit) => setScreen({ name: "kitDetail", kit })}
          onBack={() => {
            setState(detectLadderState());
            setScreen({ name: "ladder" });
          }}
        />
      );

    case "commands":
      return <Commands onBack={() => setScreen({ name: "ladder" })} />;

    case "manage":
      return (
        <Manage
          repo={state.repo}
          onOpenKits={() => setScreen({ name: "kits" })}
          onBack={() => {
            setState(detectLadderState());
            setScreen({ name: "ladder" });
          }}
        />
      );

    case "spending":
      return <Spending onBack={() => setScreen({ name: "ladder" })} />;

    case "ladder":
    default:
      return (
        <Ladder
          state={state}
          kits={kits}
          onOpenKits={() => setScreen({ name: "kits" })}
          onOpenKit={(kit) => setScreen({ name: "kitDetail", kit })}
          onOpenExplore={() => setScreen({ name: "explore" })}
          onOpenCommands={() => setScreen({ name: "commands" })}
          onOpenManage={() => setScreen({ name: "manage" })}
          onOpenSpending={() => setScreen({ name: "spending" })}
        />
      );
  }
}
