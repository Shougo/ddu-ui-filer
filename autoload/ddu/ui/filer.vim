let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-filer') : 0

function ddu#ui#filer#do_action(name, options = {}) abort
  return ddu#ui#do_action(a:name, a:options)
endfunction

function ddu#ui#filer#multi_actions(actions) abort
  return ddu#ui#multi_actions(a:actions)
endfunction

function ddu#ui#filer#_update_buffer(
      \ params, bufnr, lines, refreshed, pos) abort
  const current_lines = '$'->line(a:bufnr->bufwinid())

  call setbufvar(a:bufnr, '&modifiable', 1)

  " NOTE: deletebufline() changes cursor position.
  let changed_cursor = v:false
  if a:lines->empty()
    " Clear buffer
    if current_lines > 1
      if '%'->bufnr() ==# a:bufnr
        silent % delete _
      else
        silent call deletebufline(a:bufnr, 1, '$')
      endif

      let changed_cursor = v:false
    else
      call setbufline(a:bufnr, 1, [''])
    endif
  else
    call setbufline(a:bufnr, 1, a:lines)

    if current_lines > a:lines->len()
      silent call deletebufline(a:bufnr, a:lines->len() + 1, '$')
      let changed_cursor = v:false
    endif
  endif

  call setbufvar(a:bufnr, '&modifiable', 0)
  call setbufvar(a:bufnr, '&modified', 0)

  if !a:refreshed && !changed_cursor
    return
  endif

  " Init the cursor
  call win_execute(bufwinid(a:bufnr),
        \ printf('call cursor(%d, 0)', a:pos + 1))
  redraw
endfunction

function ddu#ui#filer#_highlight_items(
      \ params, bufnr, max_lines, highlight_items, selected_items) abort
  " Buffer must be loaded
  if !(a:bufnr->bufloaded())
    return
  endif

  " Clear all highlights
  if has('nvim')
    call nvim_buf_clear_namespace(0, s:namespace, 0, -1)
  else
    call prop_clear(1, a:max_lines + 1, { 'bufnr': a:bufnr })
  endif

  " Highlights items
  for item in a:highlight_items
    for hl in item.highlights
      call ddu#ui#filer#_highlight(
            \ hl.hl_group, hl.name, 1,
            \ s:namespace, a:bufnr,
            \ item.row,
            \ hl.col + strwidth(item.prefix), hl.width)
    endfor
  endfor

  " Selected items highlights
  const selected_highlight = get(a:params.highlights, 'selected', 'Statement')
  for item_nr in a:selected_items
    call ddu#ui#filer#_highlight(
          \ selected_highlight, 'ddu-ui-selected', 10000,
          \ s:namespace, a:bufnr, item_nr + 1, 1, 1000)
  endfor

  if !has('nvim')
    " NOTE: :redraw is needed for Vim
    redraw
  endif
endfunction
function ddu#ui#filer#_highlight(
      \ highlight, prop_type, priority, id, bufnr, row, col, length) abort
  if !has('nvim')
    " Add prop_type
    if a:prop_type->prop_type_get()->empty()
      call prop_type_add(a:prop_type, #{
            \   highlight: a:highlight,
            \   priority: a:priority,
            \ })
    endif
  endif

  if has('nvim')
    call nvim_buf_add_highlight(
          \ a:bufnr,
          \ a:id,
          \ a:highlight,
          \ a:row - 1,
          \ a:col - 1,
          \ a:col - 1 + a:length
          \ )
  else
    call prop_add(a:row, a:col, #{
          \   length: a:length,
          \   type: a:prop_type,
          \   bufnr: a:bufnr,
          \   id: a:id,
          \ })
  endif
endfunction

function ddu#ui#filer#_save_cursor(path) abort
  if a:path ==# ''
    return
  endif

  let b:ddu_ui_filer_cursor_pos = getcurpos()
  let b:ddu_ui_filer_cursor_text = '.'->getline()

  " NOTE: Prevent saving after quitted
  if '$'->line() == 1 && b:ddu_ui_filer_cursor_text ==# ''
    return
  endif

  if !exists('b:ddu_ui_filer_save_cursor_item')
    let b:ddu_ui_filer_save_cursor_item = {}
  endif
  let b:ddu_ui_filer_save_cursor_item[a:path] = ddu#ui#get_item()
endfunction

function ddu#ui#filer#_open_preview_window(
      \ params, bufnr, preview_bufnr, prev_winid, preview_winid) abort
  if a:preview_winid >= 0 && (!a:params.previewFloating || has('nvim'))
    call win_gotoid(a:preview_winid)
    execute 'buffer' a:preview_bufnr
    return a:preview_winid
  endif

  let preview_width = a:params.previewWidth
  let preview_height = a:params.previewHeight
  const winnr = a:bufnr->bufwinid()
  const pos = winnr->win_screenpos()
  const win_width = winnr->winwidth()
  const win_height = winnr->winheight()

  if a:params.previewSplit ==# 'vertical'
    if a:params.previewFloating
      let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
      let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1

      if a:params.previewRow <= 0 && win_row <= preview_height
        let win_col += win_width
        if (win_col + preview_width) > &columns
          let win_col -= preview_width
        endif
      endif

      if a:params.previewCol <= 0 && a:params.previewFloatingBorder !=# 'none'
        let preview_width -= 1
      endif

      if has('nvim')
        let winopts = #{
              \   relative: 'editor',
              \   row: win_row,
              \   col: win_col,
              \   width: preview_width,
              \   height: preview_height,
              \   border: a:params.previewFloatingBorder,
              \   title: a:params.previewFloatingTitle,
              \   title_pos: a:params.previewFloatingTitlePos,
              \   zindex: a:params.previewFloatingZindex,
              \ }
        if !has('nvim-0.9.0')
          " NOTE: "title" and "title_pos" needs neovim 0.9.0+
          call remove(winopts, 'title')
          call remove(winopts, 'title_pos')
        endif
        const winid = nvim_open_win(a:preview_bufnr, v:true, winopts)
      else
        const winopts = #{
              \   pos: 'topleft',
              \   posinvert: v:false,
              \   line: win_row + 1,
              \   col: win_col + 1,
              \   border: [],
              \   borderchars: [],
              \   borderhighlight: [],
              \   highlight: 'Normal',
              \   maxwidth: preview_width,
              \   minwidth: preview_width,
              \   maxheight: preview_height,
              \   minheight: preview_height,
              \   scrollbar: 0,
              \   title: a:params.previewFloatingTitle,
              \   wrap: 0,
              \   zindex: a:params.previewFloatingZindex,
              \ }
        if a:preview_winid >= 0
          call popup_close(a:preview_winid)
        endif
        const winid = a:preview_bufnr->popup_create(winopts)
      endif
    else
      call win_gotoid(winnr)
      execute 'silent rightbelow vertical sbuffer' a:preview_bufnr
      setlocal winfixwidth
      execute 'vertical resize' preview_width
      const winid = win_getid()
    endif
  elseif a:params.previewSplit ==# 'horizontal'
    if a:params.previewFloating
      let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
      let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1

      if a:params.previewRow <= 0 && a:params.previewFloatingBorder !=# 'none'
        let preview_height -= 1
      endif

      if has('nvim')
        if a:params.previewRow <= 0 && win_row <= preview_height
          let win_row += win_height + 1
          const anchor = 'NW'
        else
          const anchor = 'SW'
        endif

        let winopts = #{
              \   relative: 'editor',
              \   anchor: anchor,
              \   row: win_row,
              \   col: win_col,
              \   width: preview_width,
              \   height: preview_height,
              \   border: a:params.previewFloatingBorder,
              \   title: a:params.previewFloatingTitle,
              \   title_pos: a:params.previewFloatingTitlePos,
              \   zindex: a:params.previewFloatingZindex,
              \ }
        if !has('nvim-0.9.0')
          " NOTE: "title" and "title_pos" needs neovim 0.9.0+
          call remove(winopts, 'title')
          call remove(winopts, 'title_pos')
        endif
        const winid = nvim_open_win(a:preview_bufnr, v:true, winopts)
      else
        if a:params.previewRow <= 0
          let win_row -= preview_height + 2
        endif
        const winopts = #{
              \   pos: 'topleft',
              \   posinvert: v:false,
              \   line: win_row + 1,
              \   col: win_col + 1,
              \   border: [],
              \   borderchars: [],
              \   borderhighlight: [],
              \   highlight: 'Normal',
              \   maxwidth: preview_width,
              \   minwidth: preview_width,
              \   maxheight: preview_height,
              \   minheight: preview_height,
              \   scrollbar: 0,
              \   title: a:params.previewFloatingTitle,
              \   wrap: 0,
              \   zindex: a:params.previewFloatingZindex,
              \ }
        if a:preview_winid >= 0
          call popup_close(a:preview_winid)
        endif
        const winid = a:preview_bufnr->popup_create(winopts)
      endif
    else
      " NOTE: If winHeight is bigger than `&lines / 2`, it will be resized.
      const maxheight = &lines * 4 / 10
      if preview_height > maxheight
        let preview_height = maxheight
      endif

      call win_gotoid(winnr)
      execute 'silent aboveleft sbuffer' a:preview_bufnr
      setlocal winfixheight
      execute 'resize ' .. preview_height
      const winid = win_getid()
    endif
  elseif a:params.previewSplit ==# 'no'
    call win_gotoid(a:prev_winid)
    execute 'buffer' a:preview_bufnr
    const winid = win_getid()
  endif

  " Set options
  if a:params.previewSplit !=# 'no'
    call setwinvar(winid, '&previewwindow', v:true)
  endif
  call setwinvar(winid, '&cursorline', v:false)

  return winid
endfunction
