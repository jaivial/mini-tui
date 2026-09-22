import { colors } from "../theme";

export function ExitBanner(props: { exitStatus: string; submission: string }) {
  const ok = props.exitStatus === "Submitted" || props.exitStatus === "Complete" || props.exitStatus === "Finished";
  return (
    <box
      borderStyle="double"
      borderColor={ok ? colors.ok : colors.err}
      title="exit"
      titleColor={ok ? colors.ok : colors.err}
      paddingX={1}
      gap={1}
    >
      <text fg={ok ? colors.ok : colors.err}>
        {props.exitStatus || "finished"}
      </text>
      {props.submission ? <text fg={colors.text}>{props.submission}</text> : null}
    </box>
  );
}
