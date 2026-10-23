import path from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { Preview } from "../components/Preview.js";
import {
  installBlockedReason,
  installedMessage,
  installKit,
  isKitInstalled,
  type Kit,
  kitHasUpdate,
  postInstallCheck,
  previewKit,
  previewUninstall,
  uninstallKit,
  type VerifyResult,
} from "../core/kits.js";
import type { RepoInfo } from "../core/paths.js";
import { appendUndoEntry } from "../core/undo.js";
import { describeInvalid, describeParseFailure, type ParseFailure } from "../core/write.js";

type Stage = "preview" | "files" | "confirm-uninstall" | "done" | "failed";

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
  const [keptFiles, setKeptFiles] = useState<string[]>([]);

  const [confirmIndex, setConfirmIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const { stdout } = useStdout();

  const preview = useMemo(() => previewKit(kit, repo), [kit, repo]);
  const removal = useMemo(
    () => (stage === "confirm-uninstall" ? previewUninstall(kit, repo) : []),
    [stage, kit, repo],
  );

  // "Show me the files" as one scrollable page: every file, under its name.
  const fileLines = useMemo(() => {
    const out: Array<{ text: string; heading: boolean }> = [];
    for (const f of preview.files) {
      out.push({ text: f.displayPath, heading: true });
      for (const line of f.contents.replace(/\n$/, "").split("\n")) {
        out.push({ text: line, heading: false });
      }
      out.push({ text: "", heading: false });
    }
    return out;
  }, [preview]);
  // Room for the title, the position line and the footer.
  const pageSize = Math.max(5, (stdout?.rows ?? 24) - 9);
  const maxTop = Math.max(0, fileLines.length - pageSize);
  // A newer version of the kit than the copy ccpanel put here earlier.
  // Opened in the home folder, a project kit would change every project.
  const blockedReason = useMemo(() => installBlockedReason(kit, repo), [kit, repo]);
  const hasUpdate = useMemo(
    () => alreadyInstalled && kitHasUpdate(kit, repo),
    [alreadyInstalled, kit, repo],
  );

  useInput((input, key) => {
    if (stage === "files") {
      const clamp = (n: number) => Math.min(maxTop, Math.max(0, n));
      if (key.upArrow) setScrollTop((t) => clamp(t - 1));
      else if (key.downArrow) setScrollTop((t) => clamp(t + 1));
      else if (key.pageUp) setScrollTop((t) => clamp(t - pageSize));
      else if (key.pageDown || input === " ") setScrollTop((t) => clamp(t + pageSize));
    }
    if (key.escape) {
      if (stage === "files" || stage === "confirm-uninstall") setStage("preview");
      else onBack();
    }
    if (input === "q") onBack();
  });

  function doInstall() {
    const result = installKit(kit, repo, appendUndoEntry);
    if (!result.ok) {
      setErrorText(describeFailure(result.failure, repo.projectDir));
      setStage("failed");
      return;
    }
    setAlreadyInstalled(true);
    setVerify(postInstallCheck(kit, repo));
    setStage("done");
  }

  function doUninstall() {
    const result = uninstallKit(kit, repo, appendUndoEntry);
    if (!result.ok) {
      setErrorText(describeFailure(result.failure, repo.projectDir));
      setStage("failed");
      return;
    }
    setAlreadyInstalled(false);
    setVerify(null);
    setKeptFiles(result.keptFiles);
    setStage("done");
  }

  // Enter on whatever is highlighted first should never be the destructive
  // choice, so "Keep it" leads and "Remove it" is last.
  const actions: ListItem[] = alreadyInstalled
    ? [
        { key: "keep", label: "Keep it" },
        ...(hasUpdate && !blockedReason
          ? [{ key: "install", label: "Update it to the latest version" }]
          : []),
        { key: "files", label: "Show me the files" },
        { key: "uninstall", label: "Remove it" },
      ]
    : [
        ...(blockedReason ? [] : [{ key: "install", label: "Set it up" }]),
        { key: "files", label: "Show me the files" },
      ];

  function onSubmit(item: ListItem) {
    if (item.key === "install") doInstall();
    else if (item.key === "uninstall") {
      // Never one keypress: show exactly what goes, then ask.
      setConfirmIndex(0);
      setStage("confirm-uninstall");
    } else if (item.key === "files") {
      setScrollTop(0);
      setStage("files");
    } else if (item.key === "keep") onBack();
  }

  if (stage === "files") {
    const visible = fileLines.slice(scrollTop, scrollTop + pageSize);
    const more = fileLines.length - (scrollTop + visible.length);
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>{kit.title}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1}>
          {visible.map((line, i) =>
            line.heading ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
              <Text key={`${scrollTop + i}`} bold>
                {line.text}
              </Text>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
              <Text key={`${scrollTop + i}`} dimColor wrap="truncate-end">
                {line.text || " "}
              </Text>
            ),
          )}
          <Text color="cyan">
            {fileLines.length === 0
              ? "This kit adds no files, only the settings shown before."
              : `Lines ${scrollTop + 1}–${scrollTop + visible.length} of ${fileLines.length}${more > 0 ? ` · ${more} more below` : ""}`}
          </Text>
          {preview.files.some((f) => f.sourcePath) ? (
            <Text dimColor>The full files are in {kit.dir}</Text>
          ) : null}
        </Box>
        <Footer
          hints={[
            { key: "↑↓", label: "scroll" },
            { key: "PgUp/PgDn", label: "page" },
            { key: "Esc", label: "back" },
          ]}
        />
      </Box>
    );
  }

  if (stage === "confirm-uninstall") {
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>{kit.title}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text>Removing it will:</Text>
          <Box flexDirection="column" marginTop={1}>
            {removal.length === 0 ? (
              <Text dimColor> change nothing: none of it is here any more</Text>
            ) : null}
            {removal.map((line) => (
              <Box key={`${line.action}-${line.displayPath}-${line.note}`} flexDirection="column">
                <Text>
                  {"  "}
                  <Text
                    color={
                      line.action === "delete" ? "red" : line.action === "keep" ? "green" : "yellow"
                    }
                  >
                    {line.action === "delete" ? "-" : line.action === "keep" ? "=" : "~"}
                  </Text>
                  {"  "}
                  {line.displayPath}
                  <Text dimColor>{`  ${line.note}`}</Text>
                </Text>
                {(line.details ?? []).map((d) => (
                  <Box key={d} paddingLeft={5}>
                    <Text>{d}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <List
              items={[
                { key: "cancel", label: "No, keep it" },
                { key: "confirm", label: "Yes, remove it" },
              ]}
              selectedIndex={confirmIndex}
              onSelectedIndexChange={setConfirmIndex}
              onSubmit={(item) => {
                if (item.key === "confirm") doUninstall();
                else setStage("preview");
              }}
            />
          </Box>
        </Box>
        <Footer
          hints={[
            { key: "Enter", label: "choose" },
            { key: "Esc", label: "back" },
          ]}
        />
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
              <Text color="green">{installedMessage(kit)}</Text>

              {verify ? (
                <Box flexDirection="column" marginTop={1}>
                  {verify.checks.map((c) => (
                    <Box key={c.label} flexDirection="column">
                      <Text color={c.ok ? "green" : "red"}>
                        {c.ok ? "✓ " : "✗ "}
                        {c.label}
                      </Text>
                      {c.detail ? (
                        <Text dimColor>
                          {"   "}
                          {c.detail}
                        </Text>
                      ) : null}
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
            <Box flexDirection="column">
              <Text color="green">
                {keptFiles.length === 0
                  ? "Removed. Everything it added is gone."
                  : "Removed, apart from things that are yours."}
              </Text>
              {keptFiles.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    These were kept because you had changed them, or they were there before:
                  </Text>
                  {keptFiles.map((f) => (
                    <Text key={f} dimColor>
                      {"  "}
                      {path.relative(repo.projectDir, f) || f}
                    </Text>
                  ))}
                  <Text dimColor>Delete them yourself if you don't want them any more.</Text>
                </Box>
              ) : null}
            </Box>
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

        {blockedReason ? (
          <Box marginTop={1}>
            <Text color="red">{blockedReason}</Text>
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

function describeFailure(failure: unknown, projectDir: string): string {
  if (typeof failure !== "object" || failure === null) return "Something went wrong.";
  const f = failure as { reason?: string; message?: string; filePath?: string };
  if (f.reason === "unparseable") {
    return describeParseFailure((failure as { failure: ParseFailure }).failure, projectDir);
  }
  if (f.reason === "invalid") {
    return describeInvalid(failure as Parameters<typeof describeInvalid>[0]);
  }
  if (f.reason === "conflict") {
    return f.message ?? "A different file is already where this one would go.";
  }
  return f.message ?? "Something went wrong.";
}
