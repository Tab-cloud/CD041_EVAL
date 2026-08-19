import { useState } from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { XIcon, FolderIcon } from "./Icons"
import { useI18n } from "../i18n"

interface Props {
  onClose: () => void
  onCreate: (title: string, workspace: string) => void
  onSelectWorkspace: (path: string) => void
  initialWorkspace?: string
}

export function NewTaskDialog({ onClose, onCreate, onSelectWorkspace, initialWorkspace = "" }: Props) {
  const { t } = useI18n()
  const [workspace, setWorkspace] = useState<string>(initialWorkspace)
  const [title, setTitle] = useState<string>("")
  const [picking, setPicking] = useState(false)

  const pickFolder = async () => {
    try {
      setPicking(true)
      const selected = await openDialog({ directory: true, multiple: false, title: t("newTask.pickDialog") })
      const path = typeof selected === "string" ? selected : ""
      if (path) {
        setWorkspace(path)
        onSelectWorkspace(path)
      }
    } catch (err: any) {
      console.error("选择目录失败:", err)
    } finally {
      setPicking(false)
    }
  }

  const handleCreate = () => {
    if (!workspace) return
    const finalTitle = title.trim() || workspace.split(/[/\\]/).pop() || t("newTask.title")
    onCreate(finalTitle, workspace)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 520 }}>
        <div className="modal-header">
          <span>{t("newTask.title")}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><XIcon size={14} /></button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">{t("newTask.workspace")} <span className="form-required">*</span></label>
            <div className="form-workspace">
              <input
                className="input-field form-workspace-path"
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
                placeholder={t("newTask.workspacePlaceholder")}
                aria-label={t("newTask.workspace")}
              />
              <button className="form-workspace-pick" onClick={pickFolder} disabled={picking}>
                <FolderIcon size={14} />
                <span>{picking ? t("newTask.picking") : t("newTask.browse")}</span>
              </button>
            </div>
            <p className="form-hint">{t("newTask.workspaceHint")}</p>
          </div>

          <div className="form-row">
            <label className="form-label">{t("newTask.taskTitle")}</label>
            <input
              className="input-field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("newTask.titlePlaceholder")}
              autoFocus
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={!workspace}>{t("newTask.create")}</button>
        </div>
      </div>
    </div>
  )
}
