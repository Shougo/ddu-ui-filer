import {
  ActionFlags,
  BaseActionParams,
  BufferPreviewer,
  Context,
  DduItem,
  NoFilePreviewer,
  PreviewContext,
  Previewer,
  TerminalPreviewer,
} from "https://deno.land/x/ddu_vim@v3.10.2/types.ts";
import {
  batch,
  Denops,
  ensure,
  fn,
  is,
} from "https://deno.land/x/ddu_vim@v3.10.2/deps.ts";
import { replace } from "https://deno.land/x/denops_std@v6.0.1/buffer/mod.ts";
import { Params } from "../filer.ts";

type PreviewParams = {
  syntaxLimitChars?: number;
};

export class PreviewUi {
  #previewWinId = -1;
  #previewedTarget?: DduItem;
  #previewedUiParams?: Params;
  #previewedBufnrs: Set<number> = new Set();

  async close(denops: Denops, context: Context, uiParams: Params) {
    if (this.visible() && (await fn.winnr(denops, "$")) !== 1) {
      if (uiParams.previewFloating && denops.meta.host !== "nvim") {
        await denops.call("popup_close", this.#previewWinId);
      } else {
        const saveId = await fn.win_getid(denops);
        await batch(denops, async (denops) => {
          await fn.win_gotoid(denops, this.#previewWinId);
          if (this.#previewWinId === context.winId) {
            await denops.cmd(
              context.bufName === "" ? "enew" : `buffer ${context.bufNr}`,
            );
          } else {
            await denops.cmd("close!");
          }
          await fn.win_gotoid(denops, saveId);
        });
      }
      this.#previewWinId = -1;
    }
  }

  async removePreviewedBuffers(denops: Denops) {
    await batch(denops, async (denops) => {
      for (const bufnr of this.#previewedBufnrs) {
        await denops.cmd(
          `if bufexists(${bufnr}) && bufwinnr(${bufnr}) < 0 | silent bwipeout! ${bufnr} | endif`,
        );
      }
    });
  }

  async execute(
    denops: Denops,
    command: string,
  ) {
    if (!this.visible()) {
      return;
    }
    await fn.win_execute(denops, this.#previewWinId, command);
  }

  isAlreadyPreviewed(item: DduItem): boolean {
    return this.visible() &&
      JSON.stringify(item) === JSON.stringify(this.#previewedTarget);
  }

  isChangedUiParams(params: Params): boolean {
    return JSON.stringify(params) !== JSON.stringify(this.#previewedUiParams);
  }

  visible(): boolean {
    return this.#previewWinId > 0;
  }

  get previewWinId(): number {
    return this.#previewWinId;
  }

  async previewContents(
    denops: Denops,
    context: Context,
    uiParams: Params,
    actionParams: unknown,
    bufnr: number,
    item: DduItem,
    getPreviewer?: (
      denops: Denops,
      item: DduItem,
      actionParams: BaseActionParams,
      previewContext: PreviewContext,
    ) => Promise<Previewer | undefined>,
  ): Promise<ActionFlags> {
    if (this.isAlreadyPreviewed(item) || !getPreviewer) {
      return ActionFlags.None;
    }

    const prevId = await fn.win_getid(denops);
    const previewParams = ensure(actionParams, is.Record) as PreviewParams;

    const previewContext: PreviewContext = {
      col: Number(uiParams.previewCol),
      row: Number(uiParams.previewRow),
      width: Number(uiParams.previewWidth),
      height: Number(uiParams.previewHeight),
      isFloating: uiParams.previewFloating,
      split: uiParams.previewSplit,
    };
    const previewer = await getPreviewer(
      denops,
      item,
      actionParams as BaseActionParams,
      previewContext,
    );

    if (!previewer) {
      return ActionFlags.None;
    }

    let flag: ActionFlags;
    // Render the preview
    if (previewer.kind === "terminal") {
      flag = await this.#previewContentsTerminal(
        denops,
        previewer,
        uiParams,
        bufnr,
        context.winId,
      );
    } else {
      flag = await this.#previewContentsBuffer(
        denops,
        previewer,
        uiParams,
        previewParams,
        bufnr,
        context.winId,
        item,
      );
    }
    if (flag === ActionFlags.None) {
      return flag;
    }

    if (uiParams.previewFloating && denops.meta.host === "nvim") {
      const highlight = uiParams.highlights?.floating ?? "NormalFloat";
      const borderHighlight = uiParams.highlights?.floatingBorder ??
        "FloatBorder";
      await fn.setwinvar(
        denops,
        this.#previewWinId,
        "&winhighlight",
        `Normal:${highlight},FloatBorder:${borderHighlight}`,
      );
    }

    await this.#jump(denops, previewer);

    if (uiParams.onPreview) {
      if (typeof uiParams.onPreview === "string") {
        await denops.call(
          "denops#callback#call",
          uiParams.onPreview,
          {
            context,
            item,
            previewWinId: this.#previewWinId,
          },
        );
      } else {
        await uiParams.onPreview({
          denops,
          context,
          item,
          previewWinId: this.#previewWinId,
        });
      }
    }

    this.#previewedBufnrs.add(await fn.bufnr(denops));
    this.#previewedTarget = item;
    this.#previewedUiParams = uiParams;
    await fn.win_gotoid(denops, prevId);

    return ActionFlags.Persist;
  }

  async #previewContentsTerminal(
    denops: Denops,
    previewer: TerminalPreviewer,
    uiParams: Params,
    bufnr: number,
    previousWinId: number,
  ): Promise<ActionFlags> {
    if (!this.visible()) {
      this.#previewWinId = await denops.call(
        "ddu#ui#filer#_open_preview_window",
        uiParams,
        bufnr,
        bufnr,
        previousWinId,
        this.#previewWinId,
      ) as number;
    } else {
      await fn.win_gotoid(denops, this.#previewWinId);
    }

    // NOTE: ":terminal" overwrites current buffer.
    // NOTE: Use enew! to ignore E948
    await denops.cmd("enew!");

    const opts: Record<string, unknown> = {};
    if (previewer.cwd) {
      opts.cwd = previewer.cwd;
    }

    if (denops.meta.host === "nvim") {
      await denops.call("termopen", previewer.cmds, opts);
    } else {
      await denops.call("term_start", previewer.cmds, {
        ...opts,
        curwin: true,
        term_kill: "kill",
      });
    }

    return ActionFlags.Persist;
  }

  async #previewContentsBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    uiParams: Params,
    actionParams: PreviewParams,
    bufnr: number,
    previousWinId: number,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (
      previewer.kind === "nofile" && !previewer.contents?.length ||
      previewer.kind === "buffer" && !previewer.expr && !previewer.path
    ) {
      return ActionFlags.None;
    }

    const buffer = await this.#getPreviewBuffer(denops, previewer, item);
    const exists = await fn.bufexists(denops, buffer.bufnr);
    let previewBufnr = buffer.bufnr;
    const [err, contents] = await this.#getContents(denops, previewer);
    if (err || !exists || previewer.kind === "nofile") {
      // Create new buffer
      previewBufnr = await fn.bufadd(denops, buffer.bufname);
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, previewBufnr, "&buftype", "nofile");
        await fn.setbufvar(denops, previewBufnr, "&swapfile", 0);
        await fn.setbufvar(denops, previewBufnr, "&bufhidden", "hide");
        await fn.setbufvar(denops, previewBufnr, "&modeline", 1);

        await fn.bufload(denops, previewBufnr);
        await replace(denops, previewBufnr, contents);
      });
    }

    this.#previewWinId = await denops.call(
      "ddu#ui#filer#_open_preview_window",
      uiParams,
      bufnr,
      previewBufnr,
      previousWinId,
      this.#previewWinId,
    ) as number;

    const limit = actionParams.syntaxLimitChars ?? 400000;
    if (contents.join("\n").length < limit) {
      if (previewer.filetype) {
        await fn.setbufvar(
          denops,
          previewBufnr,
          "&filetype",
          previewer.filetype,
        );
      } else if (previewer.kind === "buffer") {
        await fn.win_execute(denops, this.#previewWinId, "filetype detect");
      }

      if (previewer.syntax) {
        await fn.setbufvar(denops, previewBufnr, "&syntax", previewer.syntax);
      }
    }

    // Set options
    await batch(denops, async (denops: Denops) => {
      for (const [option, value] of uiParams.previewWindowOptions) {
        await fn.setwinvar(denops, this.#previewWinId, option, value);
      }
    });

    return ActionFlags.Persist;
  }

  async #getPreviewBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    item: DduItem,
  ): Promise<{
    bufname: string;
    bufnr: number;
  }> {
    let bufname = "";
    if (previewer.kind === "buffer") {
      if (previewer.expr) {
        const name = await fn.bufname(denops, previewer.expr);
        if (previewer.useExisting) {
          if (typeof previewer.expr === "string") {
            return {
              bufname: previewer.expr,
              bufnr: await fn.bufnr(denops, previewer.expr),
            };
          } else {
            return {
              bufname: name,
              bufnr: previewer.expr,
            };
          }
        } else if (!name.length) {
          bufname = `ddu-ff:no-name:${previewer.expr}`;
        } else {
          bufname = `ddu-ff:${name}`;
        }
      } else {
        bufname = `ddu-ff:${previewer.path}`;
      }
    } else if (previewer.kind === "nofile") {
      bufname = `ddu-ff:preview`;
    } else {
      bufname = `ddu-ff:${item.word}`;
    }

    return {
      bufname,
      bufnr: await fn.bufnr(denops, bufname),
    };
  }

  async #getContents(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
  ): Promise<[err: true | undefined, contents: string[]]> {
    if (previewer.kind !== "buffer") {
      return [undefined, previewer.contents];
    }

    try {
      const bufferPath = previewer?.expr ?? previewer?.path;
      const stat = await safeStat(previewer.path);
      if (previewer.path && stat && !stat.isDirectory) {
        const data = Deno.readFileSync(previewer.path);
        const contents = new TextDecoder().decode(data).split("\n");
        return [undefined, contents];
      } else if (bufferPath && await fn.bufexists(denops, bufferPath)) {
        // Use buffer instead.
        const bufnr = await fn.bufnr(denops, bufferPath);
        await fn.bufload(denops, bufnr);
        const contents = await fn.getbufline(denops, bufnr, 1, "$");
        return [undefined, contents];
      } else {
        throw new Error(`"${previewer.path}" cannot be opened.`);
      }
    } catch (e: unknown) {
      const contents = [
        "Error",
        `${(e as Error)?.message ?? e}`,
      ];
      return [true, contents];
    }
  }

  async #jump(denops: Denops, previewer: Previewer) {
    await batch(denops, async (denops: Denops) => {
      const hasPattern = "pattern" in previewer && previewer.pattern;
      const hasLineNr = "lineNr" in previewer && previewer.lineNr;

      if (hasPattern) {
        await fn.search(denops, previewer.pattern, "w");
      }
      if (hasLineNr && previewer.lineNr) {
        await fn.cursor(denops, [previewer.lineNr, 0]);
      }
      if (hasPattern || hasLineNr) {
        await denops.cmd("normal! zv");
        await denops.cmd("normal! zz");
      }
    });
  }
}

const safeStat = async (
  path: string | undefined,
): Promise<Deno.FileInfo | null> => {
  if (!path) {
    return null;
  }

  // NOTE: Deno.stat() may be failed
  try {
    const stat = await Deno.stat(path);
    return stat;
  } catch (_: unknown) {
    // Ignore stat exception
  }
  return null;
};
