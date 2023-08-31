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
} from "https://deno.land/x/ddu_vim@v3.6.0/types.ts";
import {
  batch,
  Denops,
  equal,
  fn,
  is,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v3.6.0/deps.ts";
import {
  errorException,
  treePath2Filename,
} from "https://deno.land/x/ddu_vim@v3.6.0/utils.ts";
import { extname } from "https://deno.land/std@0.200.0/path/mod.ts";
import { Env } from "https://deno.land/x/env@v2.2.4/env.js";
import { PreviewUi } from "./filer/preview.ts";

const env = new Env();

type HighlightGroup = {
  floating?: string;
  floatingBorder?: string;
  selected?: string;
  sourceName?: string;
  sourcePath?: string;
};

type FloatingOpts = {
  relative: "editor" | "win" | "cursor" | "mouse";
  row: number;
  col: number;
  width: number;
  height: number;
  border?: FloatingBorder;
  title?: FloatingTitle;
  title_pos?: "left" | "center" | "right";
};

type FloatingBorder =
  | "none"
  | "single"
  | "double"
  | "rounded"
  | "solid"
  | "shadow"
  | string[];

type FloatingTitleHighlight = string;

type FloatingTitle =
  | string
  | [string, FloatingTitleHighlight][];

type WindowOption = [string, number | string];

type CursorPos = [] | [lnum: number, col: number, off?: number];

type ExprNumber = string | number;

type OnPreviewArguments = {
  denops: Denops;
  context: Context;
  item: DduItem;
  previewWinId: number;
};

type PreviewExecuteParams = {
  command: string;
};

export type Params = {
  displayRoot: boolean;
  exprParams: (keyof Params)[];
  floatingBorder: FloatingBorder;
  floatingTitle: FloatingTitle;
  floatingTitlePos: "left" | "center" | "right";
  focus: boolean;
  highlights: HighlightGroup;
  onPreview: string | ((args: OnPreviewArguments) => Promise<void>);
  previewCol: ExprNumber;
  previewFloating: boolean;
  previewFloatingBorder: FloatingBorder;
  previewFloatingTitle: FloatingTitle;
  previewFloatingTitlePos: "left" | "center" | "right";
  previewFloatingZindex: number;
  previewHeight: ExprNumber;
  previewRow: ExprNumber;
  previewSplit: "horizontal" | "vertical" | "no";
  previewWidth: ExprNumber;
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
  splitDirection: "belowright" | "aboveleft";
  statusline: boolean;
  winCol: ExprNumber;
  winHeight: ExprNumber;
  winRow: ExprNumber;
  winWidth: ExprNumber;
};

type CursorActionParams = {
  count?: number;
  loop?: boolean;
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
  private refreshed = false;

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
    this.refreshed = true;
  }

  override expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
  }) {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const searchPath = JSON.stringify(args.parent.treePath);
    const index = this.items.findIndex(
      (item: DduItem) =>
        JSON.stringify(item.treePath) === searchPath &&
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

    return Promise.resolve();
  }

  override collapseItem(args: {
    item: DduItem;
  }) {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const searchPath = JSON.stringify(args.item.treePath);
    const startIndex = this.items.findIndex(
      (item: DduItem) =>
        JSON.stringify(item.treePath) === searchPath &&
        item.__sourceIndex === args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return Promise.resolve();
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

    return Promise.resolve();
  }

  override async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const pos = this.items.findIndex((item) => equal(item, args.item));

    if (pos > 0) {
      const bufnr = await this.getBufnr(args.denops);
      await this.cursor(args.denops, bufnr, [pos + 1, 0]);
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

    if (this.items.length === 0 && args.context.done) {
      // Close preview window when empty items
      await this.previewUi.close(args.denops, args.context, args.uiParams);
    }

    this.bufferName = `ddu-filer-${args.options.name}`;
    const initialized = await fn.bufexists(args.denops, this.bufferName) &&
      await fn.bufnr(args.denops, this.bufferName);
    const bufnr = initialized ||
      await this.initBuffer(args.denops, this.bufferName);

    args.uiParams = await this.resolveParams(
      args.denops,
      args.options,
      args.uiParams,
      args.context,
    );

    const hasNvim = args.denops.meta.host === "nvim";
    const floating = args.uiParams.split === "floating" && hasNvim;
    const winWidth = Number(args.uiParams.winWidth);
    let winHeight = Number(args.uiParams.winHeight);
    const winid = await fn.bufwinid(args.denops, bufnr);

    const direction = args.uiParams.splitDirection;
    if (args.uiParams.split === "horizontal") {
      // NOTE: If winHeight is bigger than `&lines / 2`, it will be resized.
      const maxWinHeight = Math.floor(
        await op.lines.getGlobal(args.denops) * 4 / 10,
      );
      if (winHeight > maxWinHeight) {
        winHeight = maxWinHeight;
      }

      if (winid >= 0) {
        await fn.win_execute(
          args.denops,
          winid,
          `resize ${winHeight}`,
        );
      } else {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      }
    } else if (args.uiParams.split === "vertical") {
      if (winid >= 0) {
        await fn.win_execute(
          args.denops,
          winid,
          `vertical resize ${winWidth}`,
        );
      } else {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +vertical\\ resize\\ ${winWidth} ${bufnr}`,
        );
      }
    } else if (floating) {
      const winOpts: FloatingOpts = {
        "relative": "editor",
        "row": Number(args.uiParams.winRow),
        "col": Number(args.uiParams.winCol),
        "width": winWidth,
        "height": winHeight,
        "border": args.uiParams.floatingBorder,
        "title": args.uiParams.floatingTitle,
        "title_pos": args.uiParams.floatingTitlePos,
      };
      if (!await fn.has(args.denops, "nvim-0.9.0")) {
        // NOTE: "title" and "title_pos" needs neovim 0.9.0+
        delete winOpts.title;
        delete winOpts.title_pos;
      }
      if (winid >= 0) {
        await args.denops.call(
          "nvim_win_set_config",
          winid,
          winOpts,
        );
      } else {
        await args.denops.call(
          "nvim_open_win",
          bufnr,
          true,
          winOpts,
        );
      }

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
      if (winid < 0) {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      }
    } else {
      await args.denops.call(
        "ddu#util#print_error",
        `Invalid split param: ${args.uiParams.split}`,
      );
      return;
    }

    // NOTE: buffers may be restored
    if (!initialized || winid < 0) {
      await this.initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    const augroupName = `${await op.filetype.getLocal(args.denops)}-${bufnr}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

    await this.setStatusline(
      args.denops,
      args.context,
      args.options,
      args.uiParams,
      bufnr,
      floating,
      augroupName,
    );

    // Update main buffer
    try {
      // NOTE: Use batch for screen flicker when highlight items.
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
          this.items.map((item, index) => {
            return {
              highlights: item.highlights ?? [],
              row: index + 1,
              prefix: "",
            };
          }).filter((item, index) =>
            item.highlights.length > 0 && !this.selectedItems.has(index)
          ),
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

    // Restore cursor
    const path = treePath2Filename(args.context.path);
    const saveItem = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_ff_save_cursor_item",
      {},
    ) as Record<string, DduItem>;
    if (saveItem[path]) {
      this.searchItem({
        denops: args.denops,
        item: saveItem[path],
      });
    } else if (this.refreshed) {
      // Default cursor
      await this.cursor(args.denops, bufnr, [1, 0]);
    }

    await vars.b.set(args.denops, "ddu_ui_filer_path", path);
    await vars.t.set(args.denops, "ddu_ui_filer_path", path);

    // Save cursor when cursor moved
    await args.denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer>` +
        " call ddu#ui#filer#_save_cursor(b:ddu_ui_filer_path)",
    );
    await args.denops.call("ddu#ui#filer#_save_cursor", path);

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

    this.refreshed = false;
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
    await this.previewUi.close(args.denops, args.context, args.uiParams);
    await this.previewUi.removePreviewedBuffers(args.denops);

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

    await args.denops.dispatcher.event(args.options.name, "close");
  }

  override actions: UiActions<Params> = {
    checkItems: (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      // NOTE: await may freeze UI
      args.denops.dispatcher.redraw(args.options.name, {
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

      const actions = await args.denops.dispatcher.getItemActionNames(
        args.options.name,
        items,
      );

      await args.denops.dispatcher.start({
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
    clearSelectAllItems: (_) => {
      this.selectedItems.clear();
      return Promise.resolve(ActionFlags.Redraw);
    },
    closePreviewWindow: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
    }) => {
      await this.previewUi.close(args.denops, args.context, args.uiParams);
      return ActionFlags.None;
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
      actionParams: unknown;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_cursor_pos",
        [],
      ) as CursorPos;
      if (cursorPos.length === 0) {
        return ActionFlags.Persist;
      }

      const params = args.actionParams as CursorActionParams;
      const count = params.count ?? 1;
      const loop = params.loop ?? false;
      if (count === 0) {
        return ActionFlags.Persist;
      }

      // Move to the next
      cursorPos[1] += count;
      if (cursorPos[1] <= 0) {
        cursorPos[1] = loop ? this.viewItems.length : 1;
      } else if (cursorPos[1] > this.viewItems.length) {
        cursorPos[1] = loop ? 1 : this.viewItems.length;
      }

      await this.cursor(args.denops, bufnr, cursorPos);

      return ActionFlags.Persist;
    },
    cursorPrevious: async (args: {
      denops: Denops;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_cursor_pos",
        [],
      ) as CursorPos;
      if (cursorPos.length === 0) {
        return ActionFlags.Persist;
      }

      const params = args.actionParams as CursorActionParams;
      const count = params.count ?? 1;
      const loop = params.loop ?? false;
      if (count === 0) {
        return ActionFlags.Persist;
      }

      // Move to the previous
      cursorPos[1] -= count;
      if (cursorPos[1] <= 0) {
        cursorPos[1] = loop ? this.viewItems.length : 1;
      } else if (cursorPos[1] > this.viewItems.length) {
        cursorPos[1] = loop ? 1 : this.viewItems.length;
      }

      await this.cursor(args.denops, bufnr, cursorPos);

      return ActionFlags.Persist;
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      const item = await this.getItem(args.denops);
      if (!item) {
        return ActionFlags.None;
      }

      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode === "toggle") {
          return await this.collapseItemAction(args.denops, args.options);
        }
        return ActionFlags.None;
      }

      await args.denops.dispatcher.redrawTree(
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
      const item = await this.getItem(args.denops);
      const bufnr = await this.getBufnr(args.denops);
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_item", item ?? {});

      return ActionFlags.None;
    },
    getItems: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_items", this.items);

      const ft = await op.filetype.getLocal(args.denops);
      if (ft === "ddu-ff-filter") {
        // Set for filter window
        await vars.b.set(args.denops, "ddu_ui_items", this.items);
      }

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

      const actions = await args.denops.dispatcher.getItemActionNames(
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
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseActionParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      args.uiParams = await this.resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      return this.previewUi.previewContents(
        args.denops,
        args.context,
        args.uiParams,
        args.actionParams,
        await this.getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
    },
    previewExecute: async (args: {
      denops: Denops;
      actionParams: unknown;
    }) => {
      const command = (args.actionParams as PreviewExecuteParams).command;
      await this.previewUi.execute(args.denops, command);
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

      args.denops.dispatcher.pop(args.options.name);

      return ActionFlags.None;
    },
    refreshItems: (_) => {
      return Promise.resolve(ActionFlags.RefreshItems);
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      await args.denops.dispatcher.redraw(args.options.name, {
        updateOptions: args.actionParams,
      });

      return ActionFlags.None;
    },
    toggleAllItems: (_) => {
      if (this.items.length === 0) {
        return Promise.resolve(ActionFlags.None);
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

      return Promise.resolve(ActionFlags.Redraw);
    },
    togglePreview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseActionParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      args.uiParams = await this.resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      // Close if the target is the same as the previous one
      if (this.previewUi.isAlreadyPreviewed(item)) {
        await this.previewUi.close(args.denops, args.context, args.uiParams);
        return ActionFlags.None;
      }

      return this.previewUi.previewContents(
        args.denops,
        args.context,
        args.uiParams,
        args.actionParams,
        await this.getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
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
      displayRoot: true,
      exprParams: [
        "previewCol",
        "previewRow",
        "previewHeight",
        "previewWidth",
        "winCol",
        "winRow",
        "winHeight",
        "winWidth",
      ],
      floatingBorder: "none",
      floatingTitle: "",
      floatingTitlePos: "left",
      focus: true,
      highlights: {},
      onPreview: (_) => {
        return Promise.resolve();
      },
      previewCol: 0,
      previewFloating: false,
      previewFloatingBorder: "none",
      previewFloatingTitle: "",
      previewFloatingTitlePos: "left",
      previewFloatingZindex: 100,
      previewHeight: 10,
      previewRow: 0,
      previewSplit: "horizontal",
      previewWidth: 80,
      previewWindowOptions: [
        ["&signcolumn", "no"],
        ["&foldcolumn", 0],
        ["&foldenable", 0],
        ["&number", 0],
        ["&wrap", 0],
      ],
      search: "",
      split: "horizontal",
      splitDirection: "belowright",
      sort: "none",
      sortTreesFirst: false,
      statusline: true,
      winCol: "(&columns - eval(uiParams.winWidth)) / 2",
      winHeight: 20,
      winRow: "&lines / 2 - 10",
      winWidth: "&columns / 2",
    };
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
    ) as CursorPos;
    if (cursorPos.length === 0) {
      return -1;
    }

    const viewItem = this.viewItems[cursorPos[1] - 1];
    return this.items.findIndex(
      (item: DduItem) => item === viewItem,
    );
  }

  private async getItem(
    denops: Denops,
  ): Promise<DduItem | null> {
    const idx = await this.getIndex(denops);
    return idx >= 0 ? this.items[idx] : null;
  }

  private async getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.selectedItems.size === 0) {
      const item = await this.getItem(denops);
      if (!item) {
        return [];
      }

      items = [item];
    } else {
      items = [...this.selectedItems].map((i) => this.items[i]);
    }

    return items.filter((item) => item);
  }

  private async collapseItemAction(denops: Denops, options: DduOptions) {
    const item = await this.getItem(denops);
    if (!item || !item.isTree) {
      return ActionFlags.None;
    }

    await denops.dispatcher.redrawTree(
      options.name,
      "collapse",
      [{ item }],
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

      await fn.setbufvar(denops, bufnr, "&bufhidden", "hide");
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-filer");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);

      if (uiParams.split === "horizontal") {
        await fn.setwinvar(denops, winid, "&winfixheight", 1);
      } else if (uiParams.split === "vertical") {
        await fn.setwinvar(denops, winid, "&winfixwidth", 1);
      }
    });
  }

  private async resolveParams(
    denops: Denops,
    options: DduOptions,
    uiParams: Params,
    context: Record<string, unknown>,
  ): Promise<Params> {
    const defaults = this.params();

    context = {
      sources: options.sources.map(
        (source) => is.String(source) ? source : source.name,
      ),
      itemCount: this.items.length,
      uiParams,
      ...context,
    };

    const params = Object.assign(uiParams);
    for (const name of uiParams.exprParams) {
      if (name in uiParams) {
        params[name] = await this.evalExprParam(
          denops,
          name,
          params[name],
          defaults[name],
          context,
        );
      } else {
        await denops.call(
          "ddu#util#print_error",
          `Invalid expr param: ${name}`,
        );
      }
    }

    return params;
  }

  private async evalExprParam(
    denops: Denops,
    name: string,
    expr: string | unknown,
    defaultExpr: string | unknown,
    context: Record<string, unknown>,
  ): Promise<unknown> {
    if (!is.String(expr)) {
      return expr;
    }

    try {
      return await denops.eval(expr, context);
    } catch (e) {
      await errorException(
        denops,
        e,
        `[ddu-ui-ff] invalid expression in option: ${name}`,
      );

      // Fallback to default param.
      return is.String(defaultExpr)
        ? await denops.eval(defaultExpr, context)
        : defaultExpr;
    }
  }

  private async getBufnr(
    denops: Denops,
  ): Promise<number> {
    return await fn.bufnr(denops, this.bufferName);
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

    const createRoot = async (source: SourceInfo) => {
      // Replace the home directory.
      let rootPath = treePath2Filename(source.path);
      if (rootPath === "") {
        rootPath = await fn.getcwd(denops) as string;
      }
      let display = rootPath;
      const home = env.get("HOME", "");
      if (home && home !== "") {
        display = display.replace(home, "~");
      }

      return {
        word: rootPath,
        display: `${source.name}:${display}`,
        action: {
          isDirectory: true,
          path: rootPath,
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
        treePath: rootPath,
        matcherKey: "word",
        __sourceIndex: source.index,
        __sourceName: source.name,
        __level: -1,
        __expanded: true,
      };
    };

    let ret: DduItem[] = [];
    for (const source of sources) {
      if (uiParams.displayRoot) {
        // Create root item from source directory
        ret.push(await createRoot(source));
      }

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

  private async setStatusline(
    denops: Denops,
    context: Context,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
    floating: boolean,
    augroupName: string,
  ): Promise<void> {
    const header = `[ddu-${options.name}]`;
    const linenr =
      "printf('%'.('$'->line())->len().'d/%d','.'->line(),'$'->line())";
    const laststatus = await op.laststatus.get(denops);
    const hasNvim = denops.meta.host === "nvim";
    const async = `${context.done ? "" : " [async]"}`;

    if (hasNvim && (floating || laststatus === 0)) {
      if (
        (await vars.g.get(denops, "ddu#ui#filer#_save_title", "")) === ""
      ) {
        const saveTitle = await denops.call(
          "nvim_get_option",
          "titlestring",
        ) as string;
        await vars.g.set(denops, "ddu#ui#filer#_save_title", saveTitle);
      }

      if (await fn.exists(denops, "##WinClosed")) {
        await denops.cmd(
          `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
            " let &titlestring=g:ddu#ui#filer#_save_title",
        );
      }

      const titleString = `${header} %{${linenr}}%*${async}`;
      await vars.b.set(denops, "ddu_ui_filer_title", titleString);

      await denops.call(
        "nvim_set_option",
        "titlestring",
        titleString,
      );
      await denops.cmd(
        `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
          " let &titlestring=b:ddu_ui_filer_title",
      );
    } else if (uiParams.statusline) {
      await fn.setwinvar(
        denops,
        await fn.bufwinnr(denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*" + async,
      );
    }
  }

  private async cursor(denops: Denops, bufnr: number, pos: CursorPos): Promise<void> {
    if (pos.length !== 0) {
      await fn.cursor(denops, pos);
    }

    await fn.setbufvar(
      denops,
      bufnr,
      "ddu_ui_filer_cursor_pos",
      pos,
    );
  }
}

const sortByFilename = (a: DduItem, b: DduItem) => {
  const nameA = a.treePath ?? a.word;
  const nameB = b.treePath ?? b.word;
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
};

const sortByExtension = (a: DduItem, b: DduItem) => {
  const nameA = extname(treePath2Filename(a.treePath ?? a.word));
  const nameB = extname(treePath2Filename(b.treePath ?? b.word));
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
