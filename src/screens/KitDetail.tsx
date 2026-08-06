import { Box, Text, useInput } from "ink";
import React, { useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { Preview } from "../components/Preview.js";
import {
  type Kit,
  type VerifyResult,
  installKit,
  isKitInstalled,
  previewKit,
  uninstallKit,
  verifyDeletionWarning,
} from "../core/kits.js";
import type { RepoInfo } from "../core/paths.js";
import { appendUndoEntry } from "../core/undo.js";

type Stage = "preview" | "files" | "done" | "failed";

interface KitDetailProps {
  kit: Kit;
  repo: RepoInfo;
  onBack: () => void;
}

export function KitDetail({ kit, repo, onBack }: KitDetailProps) {
  const [stage, setStage] = useState<Stage>("preview");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [alreadyInstalled, setAlreadyInstalled] = useState(() => isKitInstalled(kit, repo));
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const preview = useMemo(() => previewKit(kit, repo), [kit, repo]);

  useInput((input, key) => {
    if (key.escape) {
      if (stage === "files") setStage("preview");
      else onBack();
    }
    if (input === "q") onBack();
  });

  function doInstall() {
    const result = installKit(kit, repo, appendUndoEntry);
    if (!result.ok) {
      setErrorText(describeFailure(result.failure));
      setStage("failed");
      return;
    }
    setAlreadyInstalled(true);
    setVerify(verifyDeletionWarning(kit, repo));
    setStage("done");
  }

  function doUninstall() {
    const result = uninstallKit(kit, repo, appendUndoEntry);
    if (!result.ok) {
      setErrorText(describeFailure(result.failure));
      setStage("failed");
      return;
    }
    setAlreadyInstalled(false);
    setVerify(null);
    setStage("done");
  }

  const actions: ListItem[] = alreadyInstalled
    ? [
        { key: "uninstall", label: "Remove it" },
        { key: "files", label: "Show me the files" },
      ]
    : [
        { key: "install", label: "Set it up" },
        { key: "files", label: "Show me the files" },
      ];

  function onSubmit(item: ListItem) {
    if (item.key === "install") doInstall();
    else if (item.key === "uninstall") doUninstall();
    else if (item.key === "files") setStage("files");
  }

  if (stage === "files") {
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>{kit.title}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          {preview.files.map((f) => (
            <Box key={f.displayPath} flexDirection="column" marginBottom={1}>
              <Text bold>{f.displayPath}</Text>
              <Text dimColor>{f.contents.split("\n").slice(0, 40).join("\n")}</Text>
              {f.contents.split("\n").length > 40 ? <Text dimColor>…</Text> : null}
            </Box>
          ))}
        </Box>
        <Footer hints={[{ key: "Esc", label: "back" }]} />
      </Box>
    );
  }

  if (stage === "done") {
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>{kit.title}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          {alreadyInstalled ? (
            <>
              <Text color="green">Done. Claude will check with you before big deletions now.</Text>

              {verify ? (
                <Box flexDirection="column" marginTop={1}>
                  {verify.checks.map((c) => (
                    <Box key={c.label} flexDirection="column">
                      <Text color={c.ok ? "green" : "red"}>
                        {c.ok ? "✓ " : "✗ "}
                        {c.label}
                      </Text>
                      {c.detail ? <Text dimColor>{"   "}{c.detail}</Text> : null}
                    </Box>
                  ))}
                  {!verify.ok ? (
                    <Box marginTop={1}>
                      <Text color="yellow">
                        It's set up, but something above needs fixing before it can protect you.
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              ) : null}

              {kit.tryThis ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    Try this: <Text bold>{kit.tryThis}</Text>
                  </Text>
                  {kit.tryThisExplain ? <Text dimColor>{kit.tryThisExplain}</Text> : null}
                </Box>
              ) : null}

              <Box marginTop={1}>
                <Text dimColor>This works in a Claude Code session you already have open.</Text>
              </Box>
            </>
          ) : (
            <Text color="green">Removed. Everything it added is gone.</Text>
          )}
        </Box>
        <Footer hints={[{ key: "Esc", label: "back" }]} />
      </Box>
    );
  }

  if (stage === "failed") {
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>{kit.title}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text color="red">That didn't work, so nothing was changed.</Text>
          {errorText ? <Text dimColor>{errorText}</Text> : null}
        </Box>
        <Footer hints={[{ key: "Esc", label: "back" }]} />
      </Box>
    );
  }

  const hints: FooterHint[] = [
    { key: "↑↓", label: "move" },
    { key: "Enter", label: "choose" },
    { key: "Esc", label: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>{kit.title}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text>{kit.blurb}</Text>

        {alreadyInstalled ? (
          <Box marginTop={1}>
            <Text color="green">✓ This is already set up.</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Preview preview={preview} />
        </Box>

        {kit.honestLimit ? (
          <Box marginTop={1}>
            <Text color="yellow">{kit.honestLimit}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <List
            items={actions}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
            onSubmit={onSubmit}
          />
        </Box>
      </Box>

      <Footer hints={hints} />
    </Box>
  );
}

function describeFailure(failure: unknown): string {
  if (typeof failure !== "object" || failure === null) return "Something went wrong.";
  const f = failure as { reason?: string; message?: string; filePath?: string };
  if (f.reason === "unparseable") {
    return "One of your setup files has a typo in it, so it wasn't safe to change. Nothing was touched.";
  }
  if (f.reason === "conflict") {
    return "A different file is already where this one would go.";
  }
  return f.message ?? "Something went wrong.";
}
