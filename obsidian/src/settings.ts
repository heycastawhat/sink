import { PluginSettingTab, Setting, type App } from "obsidian";
import type SinkPlugin from "../main";

export class SinkSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: SinkPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const signedIn = !!p.data.token;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server address")
      .setDesc(signedIn ? "Sign out to use a different server." : "Where Sink runs, for example https://sink.example.com")
      .addText((t) =>
        t
          .setPlaceholder("https://")
          .setValue(p.data.server)
          .setDisabled(signedIn)
          .onChange((v) => {
            p.data.server = v;
            p.saveSoon();
          }),
      );

    if (signedIn) {
      new Setting(containerEl)
        .setName("Signed in")
        .setDesc(`Syncing with ${p.data.server}. ${p.statusText()}`)
        .addButton((b) => b.setButtonText("Sync now").onClick(() => void p.syncNow()))
        .addButton((b) =>
          b.setButtonText("Sign out").onClick(async () => {
            await p.signOut();
            this.display();
          }),
        );
    } else {
      new Setting(containerEl)
        .setName("Account")
        .setDesc("Opens your browser to sign in, then returns here. Nothing syncs until you do.")
        .addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => void p.signIn()));
    }

    new Setting(containerEl)
      .setName("Folder to sync")
      .setDesc(
        "A folder in this vault to sync with Sink's notes. Leave empty for the whole vault. Changing it starts a fresh merge; nothing is deleted.",
      )
      .addText((t) => {
        t.setPlaceholder("Whole vault").setValue(p.data.folder);
        t.inputEl.addEventListener("blur", () => void p.setFolder(t.getValue()));
      });
  }
}
