import { useActiveTaskArtifacts, useAppStore } from "@/store/appStore";
import { FileBadge } from "@/components/common/FileBadge";
import { IconCheck } from "@/components/common/icons";

interface Props {
  title?: string;
  rows: { file: string; summary: string; artifactId?: string }[];
}

export default function FileRecordsTable({ title, rows }: Props): React.JSX.Element {
  const artifacts = useActiveTaskArtifacts();
  const openArtifact = useAppStore((s) => s.openArtifact);

  const openFile = (file: string, artifactId?: string): void => {
    if (artifactId) {
      openArtifact(artifactId);
      return;
    }
    const name = file.split("/").pop() ?? file;
    const artifact = artifacts.find((a) => a.name === name || file.endsWith(a.name));
    if (artifact) openArtifact(artifact.id);
  };

  return (
    <div className="msg-file-table-wrap">
      {title && <p className="msg-file-table-title">{title}</p>}
      <table className="msg-file-table">
        <thead>
          <tr>
            <th>文件</th>
            <th>已写入内容</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const name = row.file.split("/").pop() ?? row.file;
            return (
              <tr key={row.file}>
                <td>
                  <button type="button" className="msg-file-link" onClick={() => openFile(row.file, row.artifactId)}>
                    <FileBadge name={name} size={16} />
                    <span>{row.file}</span>
                  </button>
                </td>
                <td>
                  <span className="msg-file-check-row">
                    <IconCheck size={14} className="msg-file-check" />
                    {row.summary}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
