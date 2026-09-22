import { markdownSyntaxStyle, colors } from "../theme";

export function TaskCard(props: { text: string }) {
  return (
    <box borderStyle="rounded" borderColor={colors.border} title="task" titleColor={colors.accent} paddingX={1}>
      <markdown content={props.text} syntaxStyle={markdownSyntaxStyle} streaming />
    </box>
  );
}
