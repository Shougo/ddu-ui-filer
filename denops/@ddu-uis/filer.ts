import {
  ActionFlags,
  type BaseParams,
  type Context,
  type DduItem,
  type DduOptions,
  type PreviewContext,
  type Previewer,
  type SourceInfo,
  type UiOptions,
} from "jsr:@shougo/ddu-vim@~10.3.0/types";
import { BaseUi, type UiActions } from "jsr:@shougo/ddu-vim@~10.3.0/ui";
import {
  convertTreePath,
  printError,
  treePath2Filename,
} from "jsr:@shougo/ddu-vim@~10.3.0/utils";

import type { Denops } from "jsr:@denops/std@~7.5.0";
import { batch } from "jsr:@denops/std@~7.5.0/batch";
import * as op from "jsr:@denops/std@~7.5.0/option";
import * as fn from "jsr:@denops/std@~7.5.0/function";
import * as vars from "jsr:@denops/std@~7.5.0/variable";

import { equal } from "jsr:@std/assert@~1.0.0/equal";
import { is } from "jsr:@core/unknownutil@~4.3.0/is";
import { SEPARATOR as pathsep } from "jsr:@std/path@~1.0.1/constants";
import { extname } from "jsr:@std/path@~1.0.0/extname";
import { ensure } from "jsr:@denops/std@~7.5.0/buffer";

import { PreviewUi } from "./filer/preview.ts";

type HighlightGroup = {
  floating?: string;
  floatingBorder?: string;
  selected?: string;
  sourceName?: string;
  sourcePath?: string;
};

type AutoAction = {
  name?: string;
  params?: unknown;
  delay?: number;
  sync?: boolean;
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

type WinInfo = {
  columns: number;
  lines: number;
  winid: number;
  tabpagebuflist: number[];
};

type OnPreviewArguments = {
  denops: Denops;
  context: Context;
  item: DduItem;
  previewContext: PreviewContext;
  previewWinId: number;
};

type OpenFilterWindowParams = {
  input?: string;
};

type PreviewExecuteParams = {
  command: string;
};

type RedrawParams = {
  method?: "refreshItems" | "uiRedraw" | "uiRefresh";
};

export type Params = {
  autoAction: AutoAction;
  autoResize: boolean;
  displayRoot: boolean;
  exprParams: (keyof Params)[];
  fileFilter: string;
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
  previewFocusable: boolean;
  previewHeight: ExprNumber;
  previewMaxSize: number;
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
  split: "horizontal" | "vertical" | "floating" | "tab" | "no";
  splitDirection: "belowright" | "aboveleft" | "topleft" | "botright";
  startAutoAction: boolean;
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
  isGrouped?: boolean;
  isInTree?: boolean;
};

export class Ui extends BaseUi<Params> {
  #bufferName = "";
  #items: DduItem[] = [];
  #viewItems: DduItem[] = [];
  #selectedItems: ObjectSet<DduItem> = new ObjectSet();
  #previewUi = new PreviewUi();
  #refreshed = false;
  #enabledAutoAction = false;
  #restcmd = "";
  #prevWinInfo: WinInfo | null = null;

  override onInit(args: {
    denops: Denops;
    uiParams: Params;
  }): void {
    this.#enabledAutoAction = args.uiParams.startAutoAction;
  }

  override async onBeforeAction(args: {
    denops: Denops;
  }): Promise<void> {
    await vars.g.set(args.denops, "ddu#ui#filer#_in_action", true);

    const bufnr = await fn.bufnr(args.denops, this.#bufferName);
    if (await fn.bufnr(args.denops, "%") === bufnr) {
      await vars.b.set(
        args.denops,
        "ddu_ui_filer_cursor_pos",
        await fn.getcurpos(args.denops),
      );
      await vars.b.set(
        args.denops,
        "ddu_ui_filer_cursor_text",
        await fn.getline(args.denops, "."),
      );
    }
  }

  override async onAfterAction(args: {
    denops: Denops;
  }): Promise<void> {
    await vars.g.set(args.denops, "ddu#ui#filer#_in_action", false);
  }

  override async refreshItems(args: {
    denops: Denops;
    context: Context;
    uiParams: Params;
    sources: SourceInfo[];
    items: DduItem[];
  }): Promise<void> {
    this.#items = await getSortedItems(
      args.denops,
      args.context,
      args.sources,
      args.uiParams,
      args.items,
    );
    await this.#updateSelectedItems(args.denops);

    this.#refreshed = true;
  }

  override async expandItem(args: {
    denops: Denops;
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
    isGrouped: boolean;
  }): Promise<number> {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const index = this.#items.findIndex(
      (item: DduItem) =>
        equal(item.treePath, args.parent.treePath) &&
        item.__sourceIndex === args.parent.__sourceIndex,
    );

    const insertItems = sortItems(args.uiParams, args.children);

    const prevLength = this.#items.length;
    if (index >= 0) {
      if (args.isGrouped) {
        // Replace parent
        this.#items[index] = insertItems[0];
      } else {
        this.#items = this.#items.slice(0, index + 1).concat(insertItems)
          .concat(
            this.#items.slice(index + 1),
          );
        this.#items[index] = args.parent;
      }
    } else {
      this.#items = this.#items.concat(insertItems);
    }

    await this.#updateSelectedItems(args.denops);

    return Promise.resolve(prevLength - this.#items.length);
  }

  override async collapseItem(args: {
    denops: Denops;
    item: DduItem;
  }): Promise<number> {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const startIndex = this.#items.findIndex(
      (item: DduItem) =>
        equal(item.treePath, args.item.treePath) &&
        item.__sourceIndex === args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return Promise.resolve(0);
    }

    const endIndex = this.#items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= args.item.__level,
    );

    const prevLength = this.#items.length;
    if (endIndex < 0) {
      this.#items = this.#items.slice(0, startIndex + 1);
    } else {
      this.#items = this.#items.slice(0, startIndex + 1).concat(
        this.#items.slice(startIndex + endIndex + 1),
      );
    }

    this.#items[startIndex] = args.item;

    await this.#updateSelectedItems(args.denops);

    return Promise.resolve(prevLength - this.#items.length);
  }

  override async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const bufnr = await this.#getBufnr(args.denops);
    if (bufnr !== await fn.bufnr(args.denops)) {
      return;
    }

    let index = this.#items.findIndex(
      (item) => equal(item, args.item),
    );
    if (index < 0) {
      // NOTE: Use treePath to search item.  Because item state may be changed.
      const itemTreePath = convertTreePath(
        args.item.treePath ?? args.item.word,
      );
      index = this.#items.findIndex(
        (item) =>
          equal(convertTreePath(item.treePath ?? item.word), itemTreePath),
      );
    }

    if (index < 0) {
      return;
    }

    const cursorPos = index + 1;

    const winHeight = await fn.winheight(args.denops, 0);
    const maxLine = await fn.line(args.denops, "$");
    if ((maxLine - cursorPos) < winHeight / 2) {
      // Adjust cursor position when cursor is near bottom.
      await args.denops.cmd("normal! Gzb");
    }
    await this.#cursor(args.denops, [cursorPos, 0]);
    if (cursorPos < winHeight / 2) {
      // Adjust cursor position when cursor is near top.
      await args.denops.cmd("normal! zb");
    }

    const path = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_filer_path",
      "",
    );
    await args.denops.call("ddu#ui#filer#_update_cursor", path);
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

    if (args.context.done && this.#items.length === 0) {
      // Close preview window when empty items
      await this.#previewUi.close(args.denops, args.context, args.uiParams);
    }

    this.#bufferName = `ddu-filer-${args.options.name}`;
    const initialized = await fn.bufexists(args.denops, this.#bufferName) &&
      await fn.bufnr(args.denops, this.#bufferName);
    const bufnr = initialized ||
      await initBuffer(args.denops, this.#bufferName);

    args.uiParams = await this.#resolveParams(
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

    if (winid < 0) {
      // The layout must be saved.
      this.#restcmd = await fn.winrestcmd(args.denops);
      this.#prevWinInfo = await getWinInfo(args.denops);
    }

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
      // statusline must be set for floating window
      const currentStatusline = await op.statusline.getLocal(args.denops);

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
      if (winid >= 0 && await fn.bufwinid(args.denops, bufnr) === winid) {
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

      const winnr = await fn.bufwinnr(args.denops, bufnr);
      const highlight = args.uiParams.highlights?.floating ?? "NormalFloat";
      const floatingHighlight = args.uiParams.highlights?.floatingBorder ??
        "FloatBorder";

      await fn.setwinvar(
        args.denops,
        winnr,
        "&winhighlight",
        `Normal:${highlight},FloatBorder:${floatingHighlight}`,
      );
      await fn.setwinvar(
        args.denops,
        winnr,
        "&statusline",
        currentStatusline,
      );
    } else if (args.uiParams.split === "tab") {
      if (winid >= 0) {
        await fn.win_gotoid(args.denops, winid);
      } else {
        // NOTE: ":tabnew" creates new empty buffer.
        await args.denops.cmd(`silent keepalt tab sbuffer ${bufnr}`);
      }
    } else if (args.uiParams.split === "no") {
      if (winid < 0) {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      }
    } else {
      await printError(
        args.denops,
        `Invalid split param: ${args.uiParams.split}`,
      );
      return;
    }

    // NOTE: buffers may be restored
    if (!initialized || winid < 0) {
      await this.#initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    await this.#setAutoAction(args.denops, args.uiParams, winid);

    const augroupName = `${await op.filetype.getLocal(args.denops)}-${bufnr}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

    await setStatusline(
      args.denops,
      args.context,
      args.options,
      args.uiParams,
      bufnr,
      floating,
      augroupName,
      this.#items,
    );

    // Update main buffer
    try {
      // NOTE: Use batch for screen flicker when highlight items.
      await batch(args.denops, async (denops: Denops) => {
        await ensure(args.denops, bufnr, async () => {
          await denops.call(
            "ddu#ui#filer#_update_buffer",
            args.uiParams,
            bufnr,
            this.#items.map((c) => (c.display ?? c.word)),
            false,
          );

          await denops.call(
            "ddu#ui#filer#_highlight_items",
            args.uiParams,
            bufnr,
            this.#items.length,
            this.#items.map((item, index) => {
              return {
                item: item,
                highlights: item.highlights ?? [],
                row: index + 1,
                prefix: "",
              };
            }).filter((highlight_item) =>
              highlight_item.highlights.length > 0 &&
              !this.#selectedItems.has(highlight_item.item)
            ),
            this.#selectedItems.values()
              .map((item) => this.#getItemIndex(item))
              .filter((index) => index >= 0),
          );
        });
      });
    } catch (e) {
      await printError(
        args.denops,
        e,
        "[ddu-ui-filer] update buffer failed",
      );
      return;
    }

    const prevWinnr = await fn.winnr(args.denops, "#");
    if (
      args.uiParams.autoResize && prevWinnr > 0 &&
      prevWinnr !== await fn.winnr(args.denops)
    ) {
      const winIds = await this.winIds({
        denops: args.denops,
        uiParams: args.uiParams,
      });
      const maxWidth = await Promise.all(
        this.#items.map((c) => fn.strwidth(args.denops, c.display ?? c.word)),
      ).then((widths) => Math.max(...widths));
      await fn.win_execute(
        args.denops,
        winIds.length > 0 ? winIds[0] : -1,
        `vertical resize ${maxWidth}`,
      );
    }

    this.#viewItems = Array.from(this.#items);

    // Restore cursor
    const path = treePath2Filename(args.context.path);
    const saveItem = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_filer_save_cursor_item",
      {},
    ) as Record<string, DduItem>;
    if (saveItem[path]) {
      this.searchItem({
        denops: args.denops,
        item: saveItem[path],
      });
    } else if (this.#refreshed) {
      // Default cursor
      await this.#cursor(args.denops, [1, 0]);
    }

    await vars.b.set(args.denops, "ddu_ui_filer_path", path);
    await vars.t.set(args.denops, "ddu_ui_filer_path", path);

    // Update cursor when cursor moved
    await args.denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer>` +
        " call ddu#ui#filer#_update_cursor(b:ddu_ui_filer_path)",
    );
    await args.denops.call("ddu#ui#filer#_update_cursor", path);

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

    await this.#doAutoAction(args.denops);

    await fn.setbufvar(args.denops, bufnr, "ddu_ui_items", this.#items);

    this.#refreshed = false;
  }

  override async visible(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    tabNr: number;
  }): Promise<boolean> {
    const bufnr = await this.#getBufnr(args.denops);
    if (args.tabNr > 0) {
      return (await fn.tabpagebuflist(args.denops, args.tabNr) as number[])
        .includes(bufnr);
    } else {
      // Search from all tabpages.
      return (await fn.win_findbuf(args.denops, bufnr) as number[]).length > 0;
    }
  }

  override async winIds(args: {
    denops: Denops;
    uiParams: Params;
  }): Promise<number[]> {
    const bufnr = await this.#getBufnr(args.denops);
    const winIds = await fn.win_findbuf(args.denops, bufnr) as number[];
    if (this.#previewUi.visible()) {
      winIds.push(this.#previewUi.previewWinId);
    }
    return winIds;
  }

  override async updateCursor(args: {
    denops: Denops;
  }) {
    const item = await this.#getItem(args.denops);
    const bufnr = await this.#getBufnr(args.denops);
    await fn.setbufvar(args.denops, bufnr, "ddu_ui_item", item ?? {});
  }

  override async clearSelectedItems(args: {
    denops: Denops;
  }) {
    this.#selectedItems.clear();
    const bufnr = await this.#getBufnr(args.denops);
    await fn.setbufvar(args.denops, bufnr, "ddu_ui_selected_items", []);
  }

  override async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    await this.#previewUi.close(args.denops, args.context, args.uiParams);
    await this.#previewUi.removePreviewedBuffers(args.denops);
    await args.denops.call("ddu#ui#filer#_reset_auto_action");

    // Move to the UI window.
    const bufnr = await this.#getBufnr(args.denops);
    if (!bufnr) {
      return;
    }

    for (
      const winid of (await fn.win_findbuf(args.denops, bufnr) as number[])
    ) {
      if (winid <= 0) {
        continue;
      }

      if (
        args.uiParams.split === "no" ||
        await fn.win_id2win(args.denops, args.context.winId) <= 0
      ) {
        await fn.win_gotoid(args.denops, winid);

        const prevName = await fn.bufname(args.denops, args.context.bufNr);
        await args.denops.cmd(
          prevName !== args.context.bufName || args.context.bufNr == bufnr
            ? "enew"
            : `buffer ${args.context.bufNr}`,
        );
      } else {
        await fn.win_gotoid(args.denops, winid);
        await args.denops.cmd("close!");

        // Focus to the previous window
        await fn.win_gotoid(args.denops, args.context.winId);
      }
    }

    // Restore options
    if (
      this.#restcmd !== "" &&
      equal(this.#prevWinInfo, await getWinInfo(args.denops))
    ) {
      // Restore the layout.
      await args.denops.cmd(this.#restcmd);
      this.#restcmd = "";
      this.#prevWinInfo = null;
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
        method: "refreshItems",
      });

      return ActionFlags.None;
    },
    chooseAction: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const items = await this.#getItems(args.denops);

      await args.denops.dispatcher.start({
        name: args.options.name,
        push: true,
        sources: [
          {
            name: "action",
            params: {
              name: args.options.name,
              items,
            },
          },
        ],
      });

      return ActionFlags.None;
    },
    clearSelectAllItems: async (args: {
      denops: Denops;
    }) => {
      await this.clearSelectedItems(args);

      return Promise.resolve(ActionFlags.Redraw);
    },
    closePreviewWindow: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
    }) => {
      await this.#previewUi.close(args.denops, args.context, args.uiParams);
      return ActionFlags.None;
    },
    collapseItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      return await this.#collapseItemAction(args.denops, args.options);
    },
    cursorNext: async (args: {
      denops: Denops;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0 || !cursorPos[1] || !cursorPos[2]) {
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
        cursorPos[1] = loop ? this.#viewItems.length : 1;
      } else if (cursorPos[1] > this.#viewItems.length) {
        cursorPos[1] = loop ? 1 : this.#viewItems.length;
      }

      await this.#cursor(args.denops, [cursorPos[1], cursorPos[2]]);

      return ActionFlags.Persist;
    },
    cursorPrevious: async (args: {
      denops: Denops;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0 || !cursorPos[1] || !cursorPos[2]) {
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
        cursorPos[1] = loop ? this.#viewItems.length : 1;
      } else if (cursorPos[1] > this.#viewItems.length) {
        cursorPos[1] = loop ? 1 : this.#viewItems.length;
      }

      await this.#cursor(args.denops, [cursorPos[1], cursorPos[2]]);

      return ActionFlags.Persist;
    },
    cursorTreeBottom: async (args: {
      denops: Denops;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0 || !cursorPos[1] || !cursorPos[2]) {
        return ActionFlags.Persist;
      }

      // Search tree top
      const item = await this.#getItem(args.denops);
      const targetLevel = item?.__level ?? 0;
      let idx = await this.#getIndex(args.denops);
      let minIndex = idx;

      while (idx < this.#viewItems.length) {
        if (this.#viewItems[idx].__level === targetLevel) {
          minIndex = idx;
        }
        if (this.#viewItems[idx].__level < targetLevel) {
          break;
        }

        idx++;
      }
      cursorPos[1] = minIndex + 1;

      await this.#cursor(args.denops, [cursorPos[1], cursorPos[2]]);

      return ActionFlags.Persist;
    },
    cursorTreeTop: async (args: {
      denops: Denops;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_filer_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0 || !cursorPos[1] || !cursorPos[2]) {
        return ActionFlags.Persist;
      }

      // Search tree top
      const item = await this.#getItem(args.denops);
      const targetLevel = item?.__level ?? 0;
      let idx = await this.#getIndex(args.denops);
      let minIndex = idx;

      while (idx >= 0) {
        if (this.#viewItems[idx].__level === targetLevel) {
          minIndex = idx;
        }
        if (this.#viewItems[idx].__level < targetLevel) {
          break;
        }

        idx--;
      }
      cursorPos[1] = minIndex + 1;

      await this.#cursor(args.denops, [cursorPos[1], cursorPos[2]]);

      return ActionFlags.Persist;
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: BaseParams;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item) {
        return ActionFlags.None;
      }

      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode === "toggle") {
          return await this.#collapseItemAction(args.denops, args.options);
        }
        return ActionFlags.None;
      }

      await args.denops.dispatcher.redrawTree(
        args.options.name,
        "expand",
        [{
          item,
          maxLevel: params.maxLevel ?? 0,
          isGrouped: params.isGrouped ?? false,
          isInTree: params.isInTree ?? false,
        }],
      );

      return ActionFlags.None;
    },
    inputAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const items = await this.#getItems(args.denops);

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
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as DoActionParams;

      const items = params.items ?? await this.#getItems(args.denops);
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
    openFilterWindow: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiOptions: UiOptions;
      uiParams: Params;
      actionParams: BaseParams;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
      inputHistory: string[];
    }) => {
      const uiParams = await this.#resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );
      const reopenPreview = this.#previewUi.visible() &&
        uiParams.split === "horizontal" && uiParams.previewSplit === "vertical";

      if (reopenPreview) {
        await this.#previewUi.close(args.denops, args.context, uiParams);
      }

      const actionParams = args.actionParams as OpenFilterWindowParams;

      args.context.input = await args.denops.call(
        "ddu#ui#_open_filter_window",
        args.uiOptions,
        actionParams.input ?? args.context.input,
        args.options.name,
        this.#items.length,
        args.inputHistory,
      ) as string;

      if (reopenPreview) {
        const item = await this.#getItem(args.denops);
        if (!item || !args.getPreviewer) {
          return ActionFlags.None;
        }

        return this.#previewUi.previewContents(
          args.denops,
          args.context,
          uiParams,
          args.actionParams,
          await this.#getBufnr(args.denops),
          item,
          args.getPreviewer,
        );
      }

      return ActionFlags.None;
    },
    preview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      args.uiParams = await this.#resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      return this.#previewUi.previewContents(
        args.denops,
        args.context,
        args.uiParams,
        args.actionParams,
        await this.#getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
    },
    previewExecute: async (args: {
      denops: Denops;
      actionParams: BaseParams;
    }) => {
      const command = (args.actionParams as PreviewExecuteParams).command;
      await this.#previewUi.execute(args.denops, command);
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

      await args.denops.cmd("doautocmd <nomodeline> User Ddu:uiQuit");

      await args.denops.dispatcher.pop(args.options.name);

      return ActionFlags.None;
    },
    redraw: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      actionParams: BaseParams;
      uiParams: Params;
    }) => {
      if (this.#previewUi.visible()) {
        // Close preview window when redraw
        await this.#previewUi.close(args.denops, args.context, args.uiParams);
        await this.#previewUi.removePreviewedBuffers(args.denops);
      }

      // NOTE: await may freeze UI
      const params = args.actionParams as RedrawParams;
      args.denops.dispatcher.redraw(args.options.name, {
        method: params?.method ?? "uiRefresh",
        searchItem: await this.#getItem(args.denops),
      });

      return ActionFlags.None;
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: BaseParams;
    }) => {
      await args.denops.dispatcher.updateOptions(
        args.options.name,
        args.actionParams,
      );

      return ActionFlags.None;
    },
    toggleAllItems: async (args: {
      denops: Denops;
      context: Context;
    }) => {
      if (this.#items.length === 0) {
        return Promise.resolve(ActionFlags.None);
      }

      this.#items.forEach((item, idx) => {
        // Skip root
        if (this.#items[idx].__level >= 0) {
          if (this.#selectedItems.has(item)) {
            this.#selectedItems.delete(item);
          } else {
            this.#selectedItems.add(item);
          }
        }
      });

      await this.#updateSelectedItems(args.denops);

      return Promise.resolve(ActionFlags.Redraw);
    },
    toggleAutoAction: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
    }) => {
      // Toggle
      this.#enabledAutoAction = !this.#enabledAutoAction;

      const winIds = await this.winIds({
        denops: args.denops,
        uiParams: args.uiParams,
      });
      await this.#setAutoAction(
        args.denops,
        args.uiParams,
        winIds.length > 0 ? winIds[0] : -1,
      );

      await this.#doAutoAction(args.denops);
      if (!this.#enabledAutoAction) {
        await this.#previewUi.close(args.denops, args.context, args.uiParams);
      }

      return ActionFlags.None;
    },
    togglePreview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      args.uiParams = await this.#resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      // Close if the target is the same as the previous one
      if (this.#previewUi.isAlreadyPreviewed(item)) {
        await this.#previewUi.close(args.denops, args.context, args.uiParams);
        return ActionFlags.None;
      }

      return this.#previewUi.previewContents(
        args.denops,
        args.context,
        args.uiParams,
        args.actionParams,
        await this.#getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item) {
        return ActionFlags.None;
      }

      if (this.#selectedItems.has(item)) {
        this.#selectedItems.delete(item);
      } else {
        this.#selectedItems.add(item);
      }

      await this.#updateSelectedItems(args.denops);

      return ActionFlags.Redraw;
    },
  };

  override params(): Params {
    return {
      autoAction: {},
      autoResize: false,
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
      fileFilter: "",
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
      previewFocusable: true,
      previewHeight: 10,
      previewMaxSize: 1000000,
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
      splitDirection: "aboveleft",
      sort: "none",
      sortTreesFirst: false,
      startAutoAction: false,
      statusline: true,
      winCol: "(&columns - eval(uiParams.winWidth)) / 2",
      winHeight: 20,
      winRow: "&lines / 2 - 10",
      winWidth: "&columns / 2",
    };
  }

  async #getIndex(
    denops: Denops,
  ): Promise<number> {
    // Convert viewItems index to items index.
    const bufnr = await this.#getBufnr(denops);
    const cursorPos = await fn.getbufvar(
      denops,
      bufnr,
      "ddu_ui_filer_cursor_pos",
      [],
    ) as number[];
    if (cursorPos.length === 0) {
      return -1;
    }

    const viewItem = this.#viewItems[cursorPos[1] - 1];
    return this.#items.findIndex(
      (item: DduItem) => equal(item, viewItem),
    );
  }

  #getItemIndex(viewItem: DduItem): number {
    return this.#items.findIndex(
      (item: DduItem) => equal(item, viewItem),
    );
  }

  async #getItem(
    denops: Denops,
  ): Promise<DduItem | undefined> {
    const idx = await this.#getIndex(denops);
    return this.#items[idx];
  }

  #getSelectedItems(): DduItem[] {
    return this.#selectedItems.values();
  }

  async #getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.#selectedItems.size() === 0) {
      const item = await this.#getItem(denops);
      if (!item) {
        return [];
      }

      items = [item];
    } else {
      items = this.#getSelectedItems();
    }

    return items.filter((item) => item);
  }

  async #collapseItemAction(denops: Denops, options: DduOptions) {
    let item = await this.#getItem(denops);
    if (!item || !item.treePath) {
      return ActionFlags.None;
    }

    if (!item.isTree || !item.__expanded) {
      // Use parent item instead.
      const treePath = typeof item.treePath === "string"
        ? item.treePath.split(pathsep)
        : item.treePath;
      const parentPath = treePath.slice(0, -1);

      const parent = this.#items.find(
        (itm) =>
          equal(
            parentPath,
            typeof itm.treePath === "string"
              ? itm.treePath.split(pathsep)
              : itm.treePath,
          ),
      );

      if (!parent?.treePath || !parent?.isTree || !parent?.__expanded) {
        return ActionFlags.None;
      }

      item = parent;
    }

    await denops.dispatcher.redrawTree(
      options.name,
      "collapse",
      [{ item }],
    );

    return ActionFlags.None;
  }

  async #initOptions(
    denops: Denops,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.bufwinid(denops, bufnr);
    const tabNr = await fn.tabpagenr(denops);
    const existsStatusColumn = await fn.exists(denops, "+statuscolumn");
    const existsWinFixBuf = await fn.exists(denops, "+winfixbuf");

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);
      await fn.settabvar(denops, tabNr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      if (existsStatusColumn) {
        await fn.setwinvar(denops, winid, "&statuscolumn", "");
      }
      if (
        existsWinFixBuf && uiParams.split !== "no" && uiParams.split !== "tab"
      ) {
        await fn.setwinvar(denops, winid, "&winfixbuf", true);
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

  async #resolveParams(
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
      itemCount: this.#items.length,
      uiParams,
      ...context,
    };

    const params = Object.assign(uiParams);
    for (const name of uiParams.exprParams) {
      if (name in uiParams) {
        params[name] = await evalExprParam(
          denops,
          name,
          params[name],
          defaults[name],
          context,
        );
      } else {
        await printError(
          denops,
          `Invalid expr param: ${name}`,
        );
      }
    }

    return params;
  }

  async #getBufnr(
    denops: Denops,
  ): Promise<number> {
    return this.#bufferName.length === 0
      ? -1
      : await fn.bufnr(denops, this.#bufferName);
  }

  async #doAutoAction(denops: Denops) {
    if (this.#enabledAutoAction) {
      await denops.call("ddu#ui#filer#_do_auto_action");
    }
  }

  async #setAutoAction(denops: Denops, uiParams: Params, winId: number) {
    const hasAutoAction = "name" in uiParams.autoAction &&
      this.#enabledAutoAction;

    await batch(denops, async (denops: Denops) => {
      await denops.call("ddu#ui#filer#_reset_auto_action");
      if (hasAutoAction) {
        const autoAction = Object.assign(
          { delay: 100, params: {}, sync: true },
          uiParams.autoAction,
        );
        await denops.call(
          "ddu#ui#filer#_set_auto_action",
          winId,
          autoAction,
        );
      }
    });
  }

  async #cursor(
    denops: Denops,
    pos: CursorPos,
  ): Promise<void> {
    if (pos.length !== 0) {
      await fn.cursor(denops, pos);
      await vars.b.set(
        denops,
        "ddu_ui_filer_cursor_pos",
        await fn.getcurpos(denops),
      );

      await this.#doAutoAction(denops);
    }

    await this.updateCursor({ denops });
  }

  async #updateSelectedItems(
    denops: Denops,
  ) {
    const setItems = new ObjectSet(this.#items);
    const toDelete = new ObjectSet<DduItem>();

    this.#selectedItems.forEach((item) => {
      if (!setItems.has(item)) {
        toDelete.add(item);
      }
    });

    toDelete.forEach((item) => this.#selectedItems.delete(item));

    await fn.setbufvar(
      denops,
      await this.#getBufnr(denops),
      "ddu_ui_selected_items",
      this.#getSelectedItems(),
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

async function initBuffer(
  denops: Denops,
  bufferName: string,
): Promise<number> {
  const bufnr = await fn.bufadd(denops, bufferName);
  await fn.setbufvar(denops, bufnr, "&modifiable", false);
  await fn.bufload(denops, bufnr);
  return bufnr;
}

async function evalExprParam(
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
    await printError(
      denops,
      e,
      `[ddu-ui-filer] invalid expression in option: ${name}`,
    );

    // Fallback to default param.
    return is.String(defaultExpr)
      ? await denops.eval(defaultExpr, context)
      : defaultExpr;
  }
}

async function getSortedItems(
  denops: Denops,
  context: Context,
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
    const rootPath = treePath2Filename(
      source.path.length === 0 ? context.path : source.path,
    );
    let display = rootPath;
    const home = Deno.env.get("HOME");
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
      isTree: false,
      treePath: rootPath,
      matcherKey: "word",
      __groupedPath: "",
      __sourceIndex: source.index,
      __sourceName: source.name,
      __level: -1,
      __expanded: true,
      __columnTexts: [],
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

    ret = ret.concat(sortItems(uiParams, sourceItems[source.index]));
  }
  return ret;
}

function sortItems(
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

  if (uiParams.fileFilter !== "") {
    const fileFilter = new RegExp(uiParams.fileFilter);
    items = items.filter((item) => item.isTree || fileFilter.test(item.word));
  }

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

async function setStatusline(
  denops: Denops,
  context: Context,
  options: DduOptions,
  uiParams: Params,
  bufnr: number,
  floating: boolean,
  augroupName: string,
  items: DduItem[],
): Promise<void> {
  const statusState = {
    done: context.done,
    filter: uiParams.fileFilter,
    name: options.name,
    maxItems: context.maxItems,
  };

  await fn.setwinvar(
    denops,
    await fn.win_getid(denops),
    "ddu_ui_filer_status",
    statusState,
  );

  if (!uiParams.statusline) {
    return;
  }

  const header = `[ddu-${options.name}]` +
    (items.length !== context.maxItems
      ? ` ${items.length}/${context.maxItems}`
      : "");
  const linenr =
    "printf('%'.('$'->line())->len().'d/%d','.'->line(),'$'->line())";
  const laststatus = await op.laststatus.getGlobal(denops);
  const input = `${context.input.length > 0 ? " " + context.input : ""}`;
  const async = `${context.done ? "" : " [async]"}`;
  const filter = uiParams.fileFilter === "" ? "" : ` [${uiParams.fileFilter}]`;
  const footer = `${input}${filter}${async}`;

  if (floating || laststatus === 0) {
    if (await vars.g.get(denops, "ddu#ui#filer#_save_title", "") === "") {
      await vars.g.set(
        denops,
        "ddu#ui#filer#_save_title",
        await op.titlestring.getGlobal(denops),
      );
    }

    await denops.cmd(
      `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
        " let &titlestring=g:ddu#ui#filer#_save_title",
    );

    const titleString = `${header} %{${linenr}}%*${footer}`;
    await vars.b.set(denops, "ddu_ui_filer_title", titleString);
    await op.titlestring.setGlobal(denops, titleString);

    await denops.cmd(
      `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
        " let &titlestring=b:->get('ddu_ui_filer_title', '')",
    );
  } else {
    await fn.setwinvar(
      denops,
      await fn.bufwinnr(denops, bufnr),
      "&statusline",
      `${header.replaceAll("%", "%%")} %#LineNR#%{${linenr}}%*${footer}`,
    );
  }
}

async function getWinInfo(
  denops: Denops,
): Promise<WinInfo> {
  return {
    columns: await op.columns.getGlobal(denops),
    lines: await op.lines.getGlobal(denops),
    winid: await fn.win_getid(denops),
    tabpagebuflist: await fn.tabpagebuflist(denops) as number[],
  };
}

class ObjectSet<T extends object> {
  #items: T[] = [];

  constructor(initialItems?: T[]) {
    if (initialItems) {
      this.#items = [...initialItems];
    }
  }

  add(item: T): void {
    if (!this.has(item)) {
      this.#items.push(item);
    }
  }

  has(item: T): boolean {
    return this.#items.some((existingItem) => equal(existingItem, item));
  }

  clear(): void {
    this.#items = [];
  }

  size(): number {
    return this.#items.length;
  }

  delete(item: T): boolean {
    const index = this.#items.findIndex((existingItem) =>
      equal(existingItem, item)
    );
    if (index !== -1) {
      this.#items.splice(index, 1);
      return true;
    }
    return false;
  }

  values(): T[] {
    return [...this.#items];
  }

  forEach(callback: (item: T, index: number, array: T[]) => void): void {
    this.#items.forEach(callback);
  }
}
