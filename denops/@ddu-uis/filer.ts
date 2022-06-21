import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  SourceInfo,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v1.8.4/types.ts";
import {
  batch,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v1.8.4/deps.ts";
import {
  isAbsolute,
  join,
} from "https://deno.land/std@0.144.0/path/mod.ts";
import { Env } from "https://deno.land/x/env@v2.2.0/env.js";

const env = new Env();

type HighlightGroup = {
  floating?: string;
  selected?: string;
};

type Params = {
  focus: boolean;
  highlights: HighlightGroup;
  search: string;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
  toggle: boolean;
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
};

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

type ExpandItemParams = {
  mode?: "toggle";
};

export type ActionData = {
  isDirectory?: boolean;
  path?: string;
};

export class Ui extends BaseUi<Params> {
  private buffers: Record<string, number> = {};
  private items: DduItem[] = [];
  private selectedItems: Set<number> = new Set();

  refreshItems(args: {
    context: Context;
    sources: SourceInfo[];
    items: DduItem[];
  }): void {
    this.items = this.getSortedItems(args.sources, args.items);
    this.selectedItems.clear();
  }

  expandItem(args: {
    parent: DduItem;
    children: DduItem[];
  }): void {
    // Search index.
    const index = this.items.findIndex(
      (item: DduItem) =>
        (item.action as ActionData).path ==
          (args.parent.action as ActionData).path &&
        item.__sourceIndex == args.parent.__sourceIndex,
    );
    if (index >= 0) {
      this.items = this.items.slice(0, index + 1).concat(args.children).concat(
        this.items.slice(index + 1),
      );
      this.items[index] = args.parent;
    } else {
      this.items = this.items.concat(args.children);
    }

    this.selectedItems.clear();
  }

  collapseItem(args: {
    item: DduItem;
  }) {
    // Search index.
    const startIndex = this.items.findIndex(
      (item: DduItem) =>
        (item.action as ActionData).path ==
          (args.item.action as ActionData).path &&
        item.__sourceIndex == args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return;
    }

    const endIndex = startIndex + this.items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= args.item.__level,
    );

    this.items = this.items.slice(0, startIndex + 1).concat(
      this.items.slice(endIndex + 1),
    );
    this.items[startIndex] = args.item;

    this.selectedItems.clear();
  }

  async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const pos = this.items.findIndex((element) => element == args.item);

    if (pos > 0) {
      await fn.cursor(args.denops, pos + 1, 0);
    }
  }

  async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    const bufferName = `ddu-filer-${args.options.name}`;
    const initialized = this.buffers[args.options.name];
    const bufnr = initialized
      ? this.buffers[args.options.name]
      : await this.initBuffer(args.denops, bufferName);
    this.buffers[args.options.name] = bufnr;

    await this.setDefaultParams(args.denops, args.uiParams);

    const prevDone = await fn.getbufvar(
      args.denops, bufnr, "ddu_ui_filer_prev_done", false)
    if (args.context.done && prevDone && args.uiParams.toggle) {
      args.context.bufNr = await fn.getbufvar(
        args.denops, bufnr, "ddu_ui_filer_prev_bufnr", -1)
      await this.quit({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
      });
      await fn.setbufvar(
        args.denops, bufnr, "ddu_ui_filer_prev_done", false);
      return;
    }

    const hasNvim = args.denops.meta.host == "nvim";
    const floating = args.uiParams.split == "floating" && hasNvim;
    const winHeight = Number(args.uiParams.winHeight);
    const winid = await fn.bufwinid(args.denops, bufnr);
    if (winid < 0) {
      const direction = args.uiParams.splitDirection;
      if (args.uiParams.split == "horizontal") {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      } else if (args.uiParams.split == "vertical") {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header +
            `sbuffer +vertical\\ resize\\ ${args.uiParams.winWidth} ${bufnr}`,
        );
      } else if (floating) {
        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": Number(args.uiParams.winRow),
          "col": Number(args.uiParams.winCol),
          "width": Number(args.uiParams.winWidth),
          "height": winHeight,
        });

        if (args.uiParams.highlights?.floating) {
          await fn.setwinvar(
            args.denops,
            await fn.bufwinnr(args.denops, bufnr),
            "&winhighlight",
            args.uiParams.highlights.floating,
          );
        }
      } else if (args.uiParams.split == "no") {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await args.denops.call(
          "ddu#util#print_error",
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
    }

    // Note: buffers may be restored
    if (!this.buffers[args.options.name] || winid < 0) {
      await this.initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    const header =
      `[ddu-${args.options.name}] ${this.items.length}/${args.context.maxItems}`;
    const linenr = "printf('%'.(len(line('$'))+2).'d/%d',line('.'),line('$'))";
    const async = `${args.context.done ? "" : "[async]"}`;
    const laststatus = await op.laststatus.get(args.denops);
    if (hasNvim && (floating || laststatus == 0)) {
      if (
        (await vars.g.get(args.denops, "ddu#ui#filer#_save_title", "")) == ""
      ) {
        const saveTitle = await args.denops.call(
          "nvim_get_option",
          "titlestring",
        ) as string;
        await vars.g.set(args.denops, "ddu#ui#filer#_save_title", saveTitle);
      }

      const augroupName = `${await op.filetype.getLocal(
        args.denops,
      )}-${args.options.name}`;
      await args.denops.cmd(`augroup ${augroupName}`);
      await args.denops.cmd(`autocmd! ${augroupName}`);
      if (await fn.exists(args.denops, "##WinClosed")) {
        await args.denops.cmd(
          `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
            " let &titlestring=g:ddu#ui#filer#_save_title",
        );
      }

      const titleString = header + " %{" + linenr + "}%*" + async;
      await vars.b.set(args.denops, "ddu_ui_filer_title", titleString);

      await args.denops.call(
        "nvim_set_option",
        "titlestring",
        titleString,
      );
      await args.denops.cmd(
        `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
          " let &titlestring=b:ddu_ui_filer_title",
      );
    } else {
      await fn.setwinvar(
        args.denops,
        await fn.bufwinnr(args.denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*" + async,
      );
    }

    // Update main buffer
    await args.denops.call(
      "ddu#ui#filer#_update_buffer",
      args.uiParams,
      bufnr,
      this.items.map((c) => (c.display ?? c.word)),
      false,
      0,
    );

    await args.denops.call(
      "ddu#ui#filer#_highlight_items",
      args.uiParams,
      bufnr,
      this.items.length,
      this.items.map((c, i) => {
        return {
          highlights: c.highlights ?? [],
          row: i + 1,
          prefix: "",
        };
      }).filter((c) => c.highlights),
      [...this.selectedItems],
    );

    const path = this.items.length == 0
      ? ""
      : (this.items[0].action as ActionData).path;
    await args.denops.call(
      "ddu#ui#filer#_restore_pos",
      path,
    );
    await vars.b.set(
      args.denops,
      "ddu_ui_filer_path",
      path,
    );

    if (args.uiParams.search != "") {
      const search = isAbsolute(args.uiParams.search)
        ? args.uiParams.search
        : join(args.context.path, args.uiParams.search);
      const item = this.items.find(
        (item) => search == (item?.action as ActionData).path ?? item.word,
      );
      if (item) {
        await this.searchItem({
          denops: args.denops,
          item,
        });
      }
    }

    if (args.context.done) {
      await fn.setbufvar(
        args.denops, bufnr, "ddu_ui_filer_prev_done", true);
      await fn.setbufvar(
        args.denops, bufnr, "ddu_ui_filer_prev_bufnr", args.context.bufNr);
    }

    if (!args.uiParams.focus) {
      await fn.win_gotoid(args.denops, args.context.winId);
    }
  }

  async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    const path = this.items.length == 0
      ? ""
      : (this.items[0].action as ActionData).path;
    await args.denops.call(
      "ddu#ui#filer#_save_pos",
      path,
    );

    if (
      args.uiParams.split == "no" || (await fn.winnr(args.denops, "$")) == 1
    ) {
      await args.denops.cmd(`buffer ${args.context.bufNr}`);
    } else {
      await args.denops.cmd("close!");
      await fn.win_gotoid(args.denops, args.context.winId);
    }

    // Restore options
    const saveTitle = await vars.g.get(
      args.denops,
      "ddu#ui#filer#_save_title",
      "",
    );
    if (saveTitle != "") {
      args.denops.call(
        "nvim_set_option",
        "titlestring",
        saveTitle,
      );
    }

    // Close preview window
    await args.denops.cmd("pclose!");

    await args.denops.call("ddu#event", args.options.name, "close");
  }

  private async getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.selectedItems.size == 0) {
      const idx = await this.getIndex(denops);
      items = [this.items[idx]];
    } else {
      items = [...this.selectedItems].map((i) => this.items[i]);
    }

    return items.filter((item) => item);
  }

  private async collapseItemAction(denops: Denops, options: DduOptions) {
    const index = await this.getIndex(denops);
    const closeItem = this.items[index];

    if (!(closeItem.action as ActionData).isDirectory) {
      return ActionFlags.None;
    }

    await denops.call(
      "ddu#redraw_tree",
      options.name,
      "collapse",
      closeItem,
    );

    return ActionFlags.None;
  }

  actions: UiActions<Params> = {
    collapseItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      return await this.collapseItemAction(args.denops, args.options);
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      const idx = await this.getIndex(args.denops);
      const item = this.items[idx];
      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode == "toggle") {
          return await this.collapseItemAction(args.denops, args.options);
        }
        return ActionFlags.None;
      }

      item.__expanded = true;

      await args.denops.call(
        "ddu#redraw_tree",
        args.options.name,
        "expand",
        item,
      );

      return ActionFlags.None;
    },
    getItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const idx = await this.getIndex(args.denops);
      const item = this.items[idx];
      const bufnr = this.buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_filer_item", item);

      return ActionFlags.None;
    },
    itemAction: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const params = args.actionParams as DoActionParams;
      const items = params.items ?? await this.getItems(args.denops);

      if (items.length != 0) {
        await args.denops.call(
          "ddu#item_action",
          args.options.name,
          params.name ?? "default",
          items,
          params.params ?? {},
        );
      }

      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    preview: async (_: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      return ActionFlags.Persist;
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.quit({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
      });
      await args.denops.call("ddu#pop", args.options.name);
      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    refreshItems: async (_: {
      denops: Denops;
    }) => {
      return ActionFlags.RefreshItems;
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      await args.denops.call("ddu#redraw", args.options.name, {
        updateOptions: args.actionParams,
      });
      return ActionFlags.None;
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      if (this.items.length == 0) {
        return ActionFlags.None;
      }

      const idx = await this.getIndex(args.denops);
      if (this.selectedItems.has(idx)) {
        this.selectedItems.delete(idx);
      } else {
        this.selectedItems.add(idx);
      }

      return ActionFlags.Redraw;
    },
  };

  params(): Params {
    return {
      focus: true,
      highlights: {},
      search: "",
      split: "horizontal",
      splitDirection: "botright",
      toggle: false,
      winCol: 0,
      winHeight: 20,
      winRow: 0,
      winWidth: 0,
    };
  }

  private async initBuffer(
    denops: Denops,
    bufferName: string,
  ): Promise<number> {
    const bufnr = await fn.bufadd(denops, bufferName);
    await fn.bufload(denops, bufnr);
    return bufnr;
  }

  private async initOptions(
    denops: Denops,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.bufwinid(denops, bufnr);

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);

      await fn.setbufvar(denops, bufnr, "&bufhidden", "unload");
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-filer");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);

      if (uiParams.split == "horizontal") {
        await fn.setbufvar(denops, bufnr, "&winfixheight", 1);
      } else if (uiParams.split == "vertical") {
        await fn.setbufvar(denops, bufnr, "&winfixwidth", 1);
      }
    });
  }

  private async setDefaultParams(denops: Denops, uiParams: Params) {
    if (uiParams.winRow == 0) {
      uiParams.winRow = Math.trunc(
        (await denops.call("eval", "&lines") as number) / 2 - 10,
      );
    }
    if (uiParams.winCol == 0) {
      uiParams.winCol = Math.trunc(
        (await op.columns.getGlobal(denops)) / 4,
      );
    }
    if (uiParams.winWidth == 0) {
      uiParams.winWidth = Math.trunc((await op.columns.getGlobal(denops)) / 2);
    }
  }

  private async getIndex(
    denops: Denops,
  ): Promise<number> {
    return (await fn.line(denops, ".")) - 1;
  }

  private getSortedItems(
    sources: SourceInfo[],
    items: DduItem[],
  ): DduItem[] {
    const sourceItems: Record<number, DduItem[]> = {};
    for (const item of items) {
      if (!sourceItems[item.__sourceIndex]) {
        sourceItems[item.__sourceIndex] = [];
      }
      sourceItems[item.__sourceIndex].push(item);
    }

    let ret: DduItem[] = [];
    for (const source of sources) {
      // Create root item from source directory

      // Replace the home directory.
      const home = env.get("HOME", "");
      let display = source.path;
      if (home && home != "") {
        display = display.replace(home, "~");
      }

      ret.push({
        word: source.path,
        display: `${source.name}:${display}`,
        action: {
          isDirectory: true,
          path: source.path,
        },
        matcherKey: "word",
        __sourceIndex: source.index,
        __sourceName: source.name,
        __level: 0,
        __expanded: false,
      });

      if (!sourceItems[source.index]) {
        continue;
      }

      const sortedSourceItems = sourceItems[source.index].sort((a, b) => {
        const nameA = (a.action as ActionData).path ?? a.word;
        const nameB = (b.action as ActionData).path ?? b.word;
        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
      });
      const dirs = sortedSourceItems.filter(
        (item) => (item.action as ActionData)?.isDirectory,
      );
      const files = sortedSourceItems.filter(
        (item) => !(item.action as ActionData)?.isDirectory,
      );
      ret = ret.concat(dirs);
      ret = ret.concat(files);
    }
    return ret;
  }
}
