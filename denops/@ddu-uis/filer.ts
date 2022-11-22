import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  ExpandItem,
  SourceInfo,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v2.0.0/types.ts";
import {
  batch,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v2.0.0/deps.ts";
import { dirname, extname } from "https://deno.land/std@0.165.0/path/mod.ts";
import { Env } from "https://deno.land/x/env@v2.2.1/env.js";

const env = new Env();

type HighlightGroup = {
  floating?: string;
  selected?: string;
  sourceName?: string;
  sourcePath?: string;
};

type Params = {
  focus: boolean;
  highlights: HighlightGroup;
  search: string;
  sort:
    | "filename"
    | "extension"
    | "none"
    | "size"
    | "time"
    | "Filename"
    | "Extension"
    | "Size"
    | "Time"
    ;
  sortTreesFirst: boolean;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
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
  maxLevel?: number;
};

export class Ui extends BaseUi<Params> {
  private buffers: Record<string, number> = {};
  private items: DduItem[] = [];
  private viewItems: DduItem[] = [];
  private selectedItems: Set<number> = new Set();
  private expandedPaths: Set<string> = new Set();

  async refreshItems(args: {
    denops: Denops;
    context: Context;
    uiParams: Params;
    sources: SourceInfo[];
    items: DduItem[];
  }): Promise<void> {
    this.items = await this.getSortedItems(
      args.denops,
      args.sources,
      args.uiParams,
      args.items,
    );
    this.selectedItems.clear();
  }

  // deno-lint-ignore require-await
  async expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
  }) {
    // Search index.
    const index = this.items.findIndex(
      (item: DduItem) =>
        item.treePath == args.parent.treePath &&
        item.__sourceIndex == args.parent.__sourceIndex,
    );

    const insertItems = this.sortItems(args.uiParams, args.children);

    if (index >= 0) {
      this.items = this.items.slice(0, index + 1).concat(insertItems).concat(
        this.items.slice(index + 1),
      );
      this.items[index] = args.parent;
    } else {
      this.items = this.items.concat(insertItems);
    }

    const path = args.parent.treePath ?? args.parent.word;
    this.expandedPaths.add(path);

    this.selectedItems.clear();
  }

  // deno-lint-ignore require-await
  async collapseItem(args: {
    item: DduItem;
  }) {
    // Search index.
    const startIndex = this.items.findIndex(
      (item: DduItem) =>
        item.treePath == args.item.treePath &&
        item.__sourceIndex == args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return;
    }

    const endIndex = this.items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= args.item.__level,
    );

    let removedItems: DduItem[] = [];
    if (endIndex < 0) {
      removedItems = this.items.slice(startIndex + 1);
      this.items = this.items.slice(0, startIndex + 1);
    } else {
      removedItems = this.items.slice(
        startIndex + 1,
        startIndex + endIndex + 1,
      );
      this.items = this.items.slice(0, startIndex + 1).concat(
        this.items.slice(startIndex + endIndex + 1),
      );
    }

    this.items[startIndex] = args.item;
    const path = args.item.treePath ?? args.item.word;

    // Remove from expandedPaths
    this.expandedPaths.delete(path);
    for (const item of removedItems) {
      const path = item.treePath ?? item.word;
      this.expandedPaths.delete(path);
    }

    this.selectedItems.clear();
  }

  async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const pos = this.items.findIndex((item) => item == args.item);

    if (pos > 0) {
      await fn.cursor(args.denops, pos + 1, 0);
      await args.denops.cmd("normal! zz");
    }
  }

  async searchPath(args: {
    denops: Denops;
    path: string;
  }) {
    const pos = this.items.findIndex(
      (item) => args.path == item.treePath ?? item.word);

    if (pos > 0) {
      await fn.cursor(args.denops, pos + 1, 0);
      await args.denops.cmd("normal! zz");
    }
  }

  async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    if (args.options.sync && !args.context.done) {
      // Skip redraw if all items are not done
      return;
    }

    const expandItems: ExpandItem[] = [];

    for (const path of this.expandedPaths) {
      const expand = this.expandPath(path);
      if (expand) {
        expandItems.push(expand);
      }
    }

    let searchItem: DduItem | undefined = undefined;
    if (args.uiParams.search != "") {
      searchItem = this.items.find(
        (item) => args.uiParams.search == item.treePath ?? item.word,
      );

      if (!searchItem) {
        const expand = this.expandPath(args.uiParams.search);
        if (expand) {
          expandItems.push(expand);
        }
      }
    }

    if (expandItems.length != 0) {
      // Need expand redraw

      // NOTE: Clear expandedPaths to prevent call "ddu#redraw_tree()" twice
      this.expandedPaths = new Set();

      await args.denops.call(
        "ddu#redraw_tree",
        args.options.name,
        "expand",
        [...new Set(expandItems)],
      );

      return;
    }

    const bufferName = `ddu-filer-${args.options.name}`;
    const initialized = this.buffers[args.options.name];
    const bufnr = initialized
      ? this.buffers[args.options.name]
      : await this.initBuffer(args.denops, bufferName);
    this.buffers[args.options.name] = bufnr;

    await this.setDefaultParams(args.denops, args.uiParams);

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

    const augroupName = `${await op.filetype.getLocal(
      args.denops,
    )}-${args.options.name}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

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
    try {
      await args.denops.call(
        "ddu#ui#filer#_update_buffer",
        args.uiParams,
        bufnr,
        this.items.map((c) => (c.display ?? c.word)),
          false,
        0,
      );
    } catch (e) {
      await errorException(
        args.denops,
        e,
        "[ddu-ui-filer] update buffer failed",
      );
      return;
    }

    this.viewItems = Array.from(this.items);

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
      : this.items[0].treePath ?? "";
    await args.denops.call(
      "ddu#ui#filer#_restore_cursor",
      path,
    );
    await vars.b.set(
      args.denops,
      "ddu_ui_filer_path",
      path,
    );

    // Save cursor when cursor moved
    await args.denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer>` +
        " call ddu#ui#filer#_save_cursor(b:ddu_ui_filer_path)",
    );

    if (searchItem) {
      await this.searchItem({
        denops: args.denops,
        item: searchItem,
      });
    }

    if (args.context.done) {
      await fn.setbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_prev_bufnr",
        args.context.bufNr,
      );
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
    // Move to the UI window.
    const bufnr = this.buffers[args.options.name];
    await fn.win_gotoid(
      args.denops,
      await fn.bufwinid(args.denops, bufnr),
    );

    if (
      args.uiParams.split == "no" || (await fn.winnr(args.denops, "$")) == 1
    ) {
      await args.denops.cmd(
        args.context.bufNr == bufnr ? "enew" : `buffer ${args.context.bufNr}`,
      );
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
      if (idx < 0) {
        return [];
      }
      items = [this.items[idx]];
    } else {
      items = [...this.selectedItems].map((i) => this.items[i]);
    }

    return items.filter((item) => item);
  }

  private async collapseItemAction(denops: Denops, options: DduOptions) {
    const index = await this.getIndex(denops);
    if (index < 0) {
      return ActionFlags.None;
    }

    const closeItem = this.items[index];

    if (!closeItem.isTree) {
      return ActionFlags.None;
    }

    await denops.call(
      "ddu#redraw_tree",
      options.name,
      "collapse",
      [{ item: closeItem }],
    );

    return ActionFlags.None;
  }

  actions: UiActions<Params> = {
    checkItems: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      await args.denops.call("ddu#redraw", args.options.name, {
        check: true,
        refreshItems: true,
      });

      return ActionFlags.None;
    },
    chooseAction: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const items = await this.getItems(args.denops);
      if (items.length == 0) {
        return ActionFlags.None;
      }

      const actions = await args.denops.call(
        "ddu#get_item_actions",
        args.options.name,
        items,
      );

      await args.denops.call("ddu#start", {
        name: args.options.name,
        push: true,
        sources: [
          {
            name: "action",
            options: {},
            params: {
              actions: actions,
              name: args.options.name,
              items: items,
            },
          },
        ],
      });

      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    clearSelectAllItems: async (_: {
      denops: Denops;
    }) => {
      this.selectedItems.clear();
      return ActionFlags.Redraw;
    },
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
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode == "toggle") {
          return await this.collapseItemAction(args.denops, args.options);
        }
        return ActionFlags.None;
      }

      await args.denops.call(
        "ddu#redraw_tree",
        args.options.name,
        "expand",
        [{ item, maxLevel: params.maxLevel ?? 0 }],
      );

      return ActionFlags.None;
    },
    getItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

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
    // deno-lint-ignore require-await
    toggleAllItems: async (_: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      if (this.items.length == 0) {
        return ActionFlags.None;
      }

      this.items.forEach((_, idx) => {
        // Skip root
        if (this.items[idx].__level >= 0) {
          if (this.selectedItems.has(idx)) {
            this.selectedItems.delete(idx);
          } else {
            this.selectedItems.add(idx);
          }
        }
      });

      return ActionFlags.Redraw;
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

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
      sort: "none",
      sortTreesFirst: false,
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
    // Convert viewItems index to items index.
    const index = (await fn.line(denops, ".")) - 1;
    const viewItem = this.viewItems[index];
    return this.items.findIndex(
      (item: DduItem) => item == viewItem,
    );
  }

  private async getSortedItems(
    denops: Denops,
    sources: SourceInfo[],
    uiParams: Params,
    items: DduItem[],
  ): Promise<DduItem[]> {
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
        highlights: [
          {
            name: "root-source-name",
            "hl_group": uiParams.highlights.sourceName ?? "Type",
            col: 1,
            width: await fn.strwidth(denops, source.name) as number,
          },
          {
            name: "root-source-path",
            "hl_group": uiParams.highlights.sourcePath ?? "String",
            col: source.name.length + 2,
            width: await fn.strwidth(denops, display) as number,
          },
        ],
        kind: source.kind,
        isTree: true,
        treePath: source.path,
        matcherKey: "word",
        __sourceIndex: source.index,
        __sourceName: source.name,
        __level: -1,
        __expanded: true,
      });

      if (!sourceItems[source.index]) {
        continue;
      }

      ret = ret.concat(this.sortItems(uiParams, sourceItems[source.index]));
    }
    return ret;
  }
  private sortItems(
    uiParams: Params,
    items: DduItem[],
  ): DduItem[] {
    const sortMethod = uiParams.sort.toLowerCase();
    const sortFunc = sortMethod == "extension"
      ? sortByExtension
      : sortMethod == "size"
      ? sortBySize
      : sortMethod == "time"
      ? sortByTime
      : sortMethod == "filename"
      ? sortByFilename
      : sortByNone;
    const reversed = uiParams.sort.toLowerCase() != uiParams.sort;

    const sortedItems = reversed
      ? items.sort(sortFunc).reverse()
      : items.sort(sortFunc);

    if (uiParams.sortTreesFirst) {
      const dirs = sortedItems.filter((item) => item.isTree);
      const files = sortedItems.filter((item) => !item.isTree);
      return dirs.concat(files);
    } else {
      return sortedItems;
    }
  }

  private expandPath(
    path: string,
  ): ExpandItem | undefined {
    let parent = path;
    let item = undefined;
    let maxLevel = 0;
    while (1) {
      item = this.items.find((item) => parent == item.treePath ?? item.word);

      if (parent == dirname(parent) || item) {
        break;
      }

      parent = dirname(parent);
      maxLevel++;
    }
    if (item && !item.__expanded) {
      return { item, search: path, maxLevel };
    }
  }
}

const sortByFilename = (a: DduItem, b: DduItem) => {
  const nameA = a.treePath ?? a.word;
  const nameB = b.treePath ?? b.word;
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
};

const sortByExtension = (a: DduItem, b: DduItem) => {
  const nameA = extname(a.treePath ?? a.word);
  const nameB = extname(b.treePath ?? b.word);
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
};

const sortBySize = (a: DduItem, b: DduItem) => {
  const sizeA = a.status?.size ?? -1;
  const sizeB = b.status?.size ?? -1;
  return sizeA < sizeB ? -1 : sizeA > sizeB ? 1 : 0;
};

const sortByTime = (a: DduItem, b: DduItem) => {
  const timeA = a.status?.time ?? -1;
  const timeB = b.status?.time ?? -1;
  return timeA < timeB ? -1 : timeA > timeB ? 1 : 0;
};

const sortByNone = (_a: DduItem, _b: DduItem) => {
  return 0;
};

async function errorException(denops: Denops, e: unknown, message: string) {
  await denops.call(
    "ddu#util#print_error",
    message,
  );
  if (e instanceof Error) {
    await denops.call(
      "ddu#util#print_error",
      e.message,
    );
    if (e.stack) {
      await denops.call(
        "ddu#util#print_error",
        e.stack,
      );
    }
  }
}
