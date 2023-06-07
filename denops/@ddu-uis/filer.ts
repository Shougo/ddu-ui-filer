import {
  ActionFlags,
  BaseActionParams,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  PreviewContext,
  Previewer,
  SourceInfo,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v2.9.0/types.ts";
import {
  batch,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v2.9.0/deps.ts";
import { extname } from "https://deno.land/std@0.177.1/path/mod.ts";
import { Env } from "https://deno.land/x/env@v2.2.3/env.js";
import { PreviewUi } from "../@ddu-ui-filer/preview.ts";

const env = new Env();

type HighlightGroup = {
  floating?: string;
  floatingBorder?: string;
  selected?: string;
  sourceName?: string;
  sourcePath?: string;
};

type FloatingBorder =
  | "none"
  | "single"
  | "double"
  | "rounded"
  | "solid"
  | "shadow"
  | string[];

type WindowOption = [string, number | string];

export type Params = {
  floatingBorder: FloatingBorder;
  focus: boolean;
  highlights: HighlightGroup;
  previewCol: number;
  previewFloating: boolean;
  previewFloatingBorder: FloatingBorder;
  previewFloatingZindex: number;
  previewHeight: number;
  previewRow: number;
  previewSplit: "horizontal" | "vertical" | "no";
  previewWidth: number;
  previewWindowOptions: WindowOption[];
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
    | "Time";
  sortTreesFirst: boolean;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
  statusline: boolean;
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
  private bufferName = "";
  private items: DduItem[] = [];
  private viewItems: DduItem[] = [];
  private selectedItems: Set<number> = new Set();
  private previewUi = new PreviewUi();

  override async refreshItems(args: {
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
  override async expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
  }) {
    // Search index.
    const index = this.items.findIndex(
      (item: DduItem) =>
        item.treePath === args.parent.treePath &&
        item.__sourceIndex === args.parent.__sourceIndex,
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

    this.selectedItems.clear();
  }

  // deno-lint-ignore require-await
  override async collapseItem(args: {
    item: DduItem;
  }) {
    // Search index.
    const startIndex = this.items.findIndex(
      (item: DduItem) =>
        item.treePath === args.item.treePath &&
        item.__sourceIndex === args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return;
    }

    const endIndex = this.items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= args.item.__level,
    );

    if (endIndex < 0) {
      this.items = this.items.slice(0, startIndex + 1);
    } else {
      this.items = this.items.slice(0, startIndex + 1).concat(
        this.items.slice(startIndex + endIndex + 1),
      );
    }

    this.items[startIndex] = args.item;

    this.selectedItems.clear();
  }

  override async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const pos = this.items.findIndex((item) => item === args.item);

    if (pos > 0) {
      await fn.cursor(args.denops, pos + 1, 0);
      await args.denops.cmd("normal! zz");
    }
  }

  override async redraw(args: {
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

    this.bufferName = `ddu-filer-${args.options.name}`;
    const initialized = await fn.bufexists(args.denops, this.bufferName) &&
      await fn.bufnr(args.denops, this.bufferName);
    const bufnr = initialized ||
      await this.initBuffer(args.denops, this.bufferName);

    await this.setDefaultParams(args.denops, args.uiParams);

    const hasNvim = args.denops.meta.host === "nvim";
    const floating = args.uiParams.split === "floating" && hasNvim;
    const winHeight = Number(args.uiParams.winHeight);
    const winid = await fn.bufwinid(args.denops, bufnr);
    if (winid < 0) {
      const direction = args.uiParams.splitDirection;
      if (args.uiParams.split === "horizontal") {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      } else if (args.uiParams.split === "vertical") {
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
          "border": args.uiParams.floatingBorder,
        });

        const highlight = args.uiParams.highlights?.floating ?? "NormalFloat";
        const floatingHighlight = args.uiParams.highlights?.floatingBorder ??
          "FloatBorder";

        await fn.setwinvar(
          args.denops,
          await fn.bufwinnr(args.denops, bufnr),
          "&winhighlight",
          `Normal:${highlight},FloatBorder:${floatingHighlight}`,
        );
      } else if (args.uiParams.split === "no") {
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
    if (!initialized || winid < 0) {
      await this.initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    const augroupName = `${await op.filetype.getLocal(args.denops)}-${bufnr}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

    const header =
      `[ddu-${args.options.name}] ${this.items.length}/${args.context.maxItems}`;
    const linenr = "printf('%'.(len(line('$'))+2).'d/%d',line('.'),line('$'))";
    const async = `${args.context.done ? "" : "[async]"}`;
    const laststatus = await op.laststatus.get(args.denops);
    if (hasNvim && (floating || laststatus === 0)) {
      if (
        (await vars.g.get(args.denops, "ddu#ui#filer#_save_title", "")) === ""
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

      const titleString = `${header} %{${linenr}}%*${async}`;
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
    } else if (args.uiParams.statusline) {
      await fn.setwinvar(
        args.denops,
        await fn.bufwinnr(args.denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*" + async,
      );
    }

    // Update main buffer
    try {
      // Note: Use batch for screen flicker when highlight items.
      await batch(args.denops, async (denops: Denops) => {
        await denops.call(
          "ddu#ui#filer#_update_buffer",
          args.uiParams,
          bufnr,
          this.items.map((c) => (c.display ?? c.word)),
          false,
          0,
        );

        await denops.call(
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
          }).filter((c) => c.highlights.length > 0),
          [...this.selectedItems],
        );
      });
    } catch (e) {
      await errorException(
        args.denops,
        e,
        "[ddu-ui-filer] update buffer failed",
      );
      return;
    }

    this.viewItems = Array.from(this.items);

    await args.denops.call("ddu#ui#filer#_restore_cursor", args.context.path);
    await vars.b.set(args.denops, "ddu_ui_filer_path", args.context.path);
    await vars.t.set(args.denops, "ddu_ui_filer_path", args.context.path);

    // Save cursor when cursor moved
    await args.denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer>` +
        " call ddu#ui#filer#_save_cursor(b:ddu_ui_filer_path)",
    );
    await args.denops.call("ddu#ui#filer#_save_cursor", args.context.path);

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

  override async visible(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    tabNr: number;
  }): Promise<boolean> {
    const bufnr = await this.getBufnr(args.denops);
    if (args.tabNr > 0) {
      return (await fn.tabpagebuflist(args.denops, args.tabNr) as number[])
        .includes(bufnr);
    } else {
      // Search from all tabpages.
      return (await fn.win_findbuf(args.denops, bufnr) as number[]).length > 0;
    }
  }

  override async winId(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<number> {
    const bufnr = await this.getBufnr(args.denops);
    const winIds = await fn.win_findbuf(args.denops, bufnr) as number[];
    return winIds.length > 0 ? winIds[0] : -1;
  }

  override async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    await this.previewUi.close(args.denops, args.context);

    // Move to the UI window.
    const bufnr = await this.getBufnr(args.denops);
    if (!bufnr) {
      return;
    }

    for (
      const winid of (await fn.win_findbuf(args.denops, bufnr) as number[])
    ) {
      if (winid <= 0) {
        continue;
      }

      await fn.win_gotoid(args.denops, winid);

      if (
        args.uiParams.split === "no" ||
        (await fn.winnr(args.denops, "$")) === 1
      ) {
        const prevName = await fn.bufname(args.denops, args.context.bufNr);
        await args.denops.cmd(
          prevName !== args.context.bufName || args.context.bufNr == bufnr
            ? "enew"
            : `buffer ${args.context.bufNr}`,
        );
      } else {
        await args.denops.cmd("close!");
        await fn.win_gotoid(args.denops, args.context.winId);
      }
    }

    // Restore options
    const saveTitle = await vars.g.get(
      args.denops,
      "ddu#ui#filer#_save_title",
      "",
    );
    if (saveTitle !== "") {
      args.denops.call(
        "nvim_set_option",
        "titlestring",
        saveTitle,
      );
    }

    await args.denops.call("ddu#event", args.options.name, "close");
  }

  override actions: UiActions<Params> = {
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
    cursorNext: async (args: {
      denops: Denops;
      uiParams: Params;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_ff_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0) {
        return ActionFlags.Persist;
      }

      // Move to the next
      cursorPos[1] += 1;
      if (0 < cursorPos[1] && cursorPos[1] <= this.viewItems.length) {
        await fn.setbufvar(
          args.denops,
          bufnr,
          "ddu_ui_ff_cursor_pos",
          cursorPos,
        );
      }

      return ActionFlags.Persist;
    },
    cursorPrevious: async (args: {
      denops: Denops;
      uiParams: Params;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0) {
        return ActionFlags.Persist;
      }

      // Move to the previous
      cursorPos[1] -= 1;
      if (0 < cursorPos[1] && cursorPos[1] <= this.viewItems.length) {
        await fn.setbufvar(
          args.denops,
          bufnr,
          "ddu_ui_filer_cursor_pos",
          cursorPos,
        );
      }

      return ActionFlags.Persist;
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
        if (params.mode === "toggle") {
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
      const bufnr = await this.getBufnr(args.denops);
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_item", item);

      return ActionFlags.None;
    },
    getSelectedItems: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const items = await this.getItems(args.denops);
      const bufnr = await this.getBufnr(args.denops);
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_selected_items", items);

      return ActionFlags.None;
    },
    inputAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const items = await this.getItems(args.denops);

      const actions = await args.denops.call(
        "ddu#get_item_actions",
        args.options.name,
        items,
      );

      const actionName = await args.denops.call(
        "ddu#util#input_list",
        "Input action name: ",
        actions,
      );
      if (actionName !== "") {
        await args.denops.call(
          "ddu#item_action",
          args.options.name,
          actionName,
          items,
          {},
        );
      }

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
      if (items.length === 0) {
        return ActionFlags.Persist;
      }

      await args.denops.call(
        "ddu#item_action",
        args.options.name,
        params.name ?? "default",
        items,
        params.params ?? {},
      );

      return ActionFlags.None;
    },
    preview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
      getPreviewer: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseActionParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      if (!item) {
        return ActionFlags.None;
      }

      return this.previewUi.previewContents(
        args.denops,
        args.context,
        args.uiParams,
        args.actionParams,
        args.getPreviewer,
        await this.getBufnr(args.denops),
        item,
      );
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
      if (this.items.length === 0) {
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

  override params(): Params {
    return {
      floatingBorder: "none",
      focus: true,
      highlights: {},
      previewCol: 0,
      previewFloating: false,
      previewFloatingBorder: "none",
      previewFloatingZindex: 100,
      previewHeight: 10,
      previewRow: 0,
      previewSplit: "horizontal",
      previewWidth: 40,
      previewWindowOptions: [
        ["&signcolumn", "no"],
        ["&foldcolumn", 0],
        ["&foldenable", 0],
        ["&number", 0],
        ["&wrap", 0],
      ],
      search: "",
      split: "horizontal",
      splitDirection: "botright",
      sort: "none",
      sortTreesFirst: false,
      statusline: true,
      winCol: 0,
      winHeight: 20,
      winRow: 0,
      winWidth: 0,
    };
  }

  private async getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.selectedItems.size === 0) {
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
    const existsStatusColumn = await fn.exists(denops, "+statuscolumn");

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
      if (existsStatusColumn) {
        await fn.setwinvar(denops, winid, "&statuscolumn", "");
      }

      await fn.setbufvar(denops, bufnr, "&bufhidden", "unload");
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-filer");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);

      if (uiParams.split === "horizontal") {
        await fn.setbufvar(denops, bufnr, "&winfixheight", 1);
      } else if (uiParams.split === "vertical") {
        await fn.setbufvar(denops, bufnr, "&winfixwidth", 1);
      }
    });
  }

  private async setDefaultParams(denops: Denops, uiParams: Params) {
    if (uiParams.winRow === 0) {
      uiParams.winRow = Math.trunc(
        (await denops.call("eval", "&lines") as number) / 2 - 10,
      );
    }
    if (uiParams.winCol === 0) {
      uiParams.winCol = Math.trunc(
        (await op.columns.getGlobal(denops)) / 4,
      );
    }
    if (uiParams.winWidth === 0) {
      uiParams.winWidth = Math.trunc((await op.columns.getGlobal(denops)) / 2);
    }
  }

  private async getBufnr(
    denops: Denops,
  ): Promise<number> {
    return await fn.bufnr(denops, this.bufferName);
  }

  private async getIndex(
    denops: Denops,
  ): Promise<number> {
    // Convert viewItems index to items index.
    const bufnr = await this.getBufnr(denops);
    const cursorPos = await fn.getbufvar(
      denops,
      bufnr,
      "ddu_ui_filer_cursor_pos",
      [],
    ) as number[];
    if (cursorPos.length === 0) {
      return -1;
    }

    const viewItem = this.viewItems[cursorPos[1] - 1];
    return this.items.findIndex(
      (item: DduItem) => item === viewItem,
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
      let root = source.path;
      if (root === "") {
        root = await fn.getcwd(denops) as string;
      }
      let display = root;
      const home = env.get("HOME", "");
      if (home && home !== "") {
        display = display.replace(home, "~");
      }

      ret.push({
        word: root,
        display: `${source.name}:${display}`,
        action: {
          isDirectory: true,
          path: root,
        },
        highlights: [
          {
            name: "root-source-name",
            hl_group: uiParams.highlights.sourceName ?? "Type",
            col: 1,
            width: await fn.strwidth(denops, source.name) as number,
          },
          {
            name: "root-source-path",
            hl_group: uiParams.highlights.sourcePath ?? "String",
            col: source.name.length + 2,
            width: await fn.strwidth(denops, display) as number,
          },
        ],
        kind: source.kind,
        isTree: true,
        treePath: root,
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
    const sortFunc = sortMethod === "extension"
      ? sortByExtension
      : sortMethod === "size"
      ? sortBySize
      : sortMethod === "time"
      ? sortByTime
      : sortMethod === "filename"
      ? sortByFilename
      : sortByNone;
    const reversed = uiParams.sort.toLowerCase() !== uiParams.sort;

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
