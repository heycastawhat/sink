import { Modal, Notice, Setting, type App } from "obsidian";
import type { SinkApi, Version } from "./api";

export function confirm(app: App, title: string, text: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    const answer = (yes: boolean) => {
      answered = true;
      resolve(yes);
      modal.close();
    };
    modal.titleEl.setText(title);
    modal.contentEl.createEl("p", { text });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => answer(false)))
      .addButton((b) => b.setButtonText(action).setWarning().onClick(() => answer(true)));
    modal.onClose = () => {
      if (!answered) resolve(false);
    };
    modal.open();
  });
}

/** A note's earlier versions on the server, newest first, each restorable. */
export class HistoryModal extends Modal {
  constructor(
    app: App,
    private api: SinkApi,
    private path: string,
    private restore: (content: string) => Promise<void>,
  ) {
    super(app);
  }

  async onOpen() {
    this.titleEl.setText(`Version history: ${this.path.split("/").pop()}`);
    this.contentEl.setText("Loading…");
    let versions: Version[];
    try {
      versions = await this.api.versions(this.path);
    } catch (err) {
      this.contentEl.setText(`Couldn't load the history: ${(err as Error).message}`);
      return;
    }
    this.contentEl.empty();
    if (!versions.length) this.contentEl.createEl("p", { text: "No earlier versions yet. Sink keeps one every few minutes you edit." });
    for (const v of versions) {
      new Setting(this.contentEl)
        .setName(new Date(v.at).toLocaleString())
        .setDesc(`${v.size.toLocaleString()} characters · ${v.preview || "(no text)"}`)
        .addButton((b) =>
          b.setButtonText("Restore").onClick(async () => {
            try {
              await this.restore((await this.api.version(this.path, v.id)).content);
              this.close();
            } catch (err) {
              new Notice(`Sink: couldn't restore: ${(err as Error).message}`);
            }
          }),
        );
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
