import { colors } from "../theme";

export function ExitBanner(props: { exitStatus: string; submission: string }) {
  const ok =
    props.exitStatus === "Submitted" || props.exitStatus === "Complete" || props.exitStatus === "Finished";
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <text fg={colors.dim}>exit · </text>
      <text fg={ok ? colors.ok : colors.err}>{props.exitStatus || "finished"}</text>
      {props.submission ? <text fg={colors.dim}>{props.submission}</text> : null}
    </box>
  );
}
