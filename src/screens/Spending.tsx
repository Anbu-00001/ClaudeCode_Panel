import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import {
  ATTRIBUTION_LIMIT,
  PERIODS,
  PERIOD_LABEL,
  PRIVACY_NOTE,
  type Period,
  type UsageOutcome,
  formatMoney,
  friendlyModel,
  getUsage,
} from "../core/ccusage.js";

interface SpendingProps {
  onBack: () => void;
}

/** Spending (§10.7). Read from local files; never a fake zero. */
export function Spending({ onBack }: SpendingProps) {
  const [period, setPeriod] = useState<Period>("daily");
  const [outcome, setOutcome] = useState<UsageOutcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setShowError(false);
    getUsage(period).then((result) => {
      if (!cancelled) {
        setOutcome(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [period]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const i = PERIODS.indexOf(period);
      const next = key.rightArrow ? i + 1 : i - 1;
      setPeriod(PERIODS[(next + PERIODS.length) % PERIODS.length] as Period);
      return;
    }
    if (key.return && outcome && !outcome.ok) setShowError((v) => !v);
  });

  const hints: FooterHint[] = [
    { key: "←→", label: "change view" },
    ...(outcome && !outcome.ok ? [{ key: "Enter", label: "show the error" }] : []),
    { key: "Esc", label: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>Spending</Text>
        <Text dimColor>
          {"    "}
          {PERIODS.map((p) => (
            <Text key={p} color={p === period ? "cyan" : undefined}>
              {PERIOD_LABEL[p]}
              {"   "}
            </Text>
          ))}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {loading ? (
          <Text dimColor>Working it out from files on your computer…</Text>
        ) : outcome?.ok ? (
          <>
            <Text>
              Everything so far: <Text bold>{formatMoney(outcome.report.totalCost)}</Text>
            </Text>

            <Box marginTop={1} flexDirection="column">
              {outcome.report.rows.slice(0, 10).map((row) => (
                <Box key={row.label}>
                  <Box width={16}>
                    <Text>{row.label}</Text>
                  </Box>
                  <Box width={11}>
                    <Text bold>{formatMoney(row.cost)}</Text>
                  </Box>
                  <Text dimColor>
                    {row.models
                      .slice(0, 3)
                      .map((m) => `${friendlyModel(m.model)} ${formatMoney(m.cost)}`)
                      .join("  ·  ")}
                  </Text>
                </Box>
              ))}
              {outcome.report.rows.length === 0 ? (
                <Text>Nothing recorded yet for this view.</Text>
              ) : null}
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text dimColor>{PRIVACY_NOTE}</Text>
              <Text dimColor>{ATTRIBUTION_LIMIT}</Text>
            </Box>
          </>
        ) : (
          <>
            <Text color="yellow">{outcome?.message}</Text>
            <Box marginTop={1}>
              <Text dimColor>
                {showError
                  ? outcome && !outcome.ok
                    ? outcome.detail
                    : ""
                  : "Press Enter to see exactly what went wrong."}
              </Text>
            </Box>
          </>
        )}
      </Box>

      <Footer hints={hints} />
    </Box>
  );
}
