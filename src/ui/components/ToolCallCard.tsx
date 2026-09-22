import { bashSyntaxStyle, colors } from "../theme";

export function ToolCallCard(props: { index: number; name: string; command: string; focused: boolean }) {
  const borderColor = props.focused ? colors.borderActive : colors.border;
  return (
    <box
      borderStyle={props.focused ? "double" : "rounded"}
      borderColor={borderColor}
      title={`❯ ${props.name} #${props.index}`}
      titleColor={props.focused ? colors.borderActive : colors.cmd}
      paddingX={1}
    >
      <code content={props.command} filetype="bash" syntaxStyle={bashSyntaxStyle} />
    </box>
  );
}
