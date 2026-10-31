import { colors } from "../theme";
import { humanSize, type StagedAttachment } from "../../attach";

/** Rows the strip takes above the prompt (0 = nothing staged: the layout is as without it). */
export function attachmentsBarRows(files: StagedAttachment[], hint: string, uploading: boolean): number {
  return (files.length || uploading ? 1 : 0) + (hint ? 1 : 0);
}

/** Files staged with `/attach` for the next prompt, and the matches of a Tab completion. */
export function AttachmentsBar(props: { files: StagedAttachment[]; hint: string; uploading: boolean }) {
  if (!attachmentsBarRows(props.files, props.hint, props.uploading)) return null;
  return (
    <box flexDirection="column" paddingX={1}>
      {props.files.length || props.uploading ? (
        <box flexDirection="row" gap={1} height={1}>
          <text fg={colors.accent}>{props.uploading ? "uploading…" : `attached (${props.files.length})`}</text>
          {props.files.map((file, i) => (
            <text key={file.path} fg={colors.dim}>
              {`${i + 1}. ${file.name} ${humanSize(file.size)}`}
            </text>
          ))}
          <text fg={colors.faint}>· sent with the next prompt · /detach [n] removes</text>
        </box>
      ) : null}
      {props.hint ? (
        <text fg={colors.faint} height={1}>
          {props.hint}
        </text>
      ) : null}
    </box>
  );
}
