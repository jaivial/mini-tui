import { markdownSyntaxStyle, colors } from "../theme";

export function TaskCard(props: { text: string }) {
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <text fg={colors.dim}>task</text>
      <markdown content={props.text} syntaxStyle={markdownSyntaxStyle} streaming />
    </box>
  );
}
