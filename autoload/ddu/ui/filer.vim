let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-filer') : 0

function! ddu#ui#filer#do_action(name, options = {}) abort
  return ddu#ui#do_action(a:name, a:options)
endfunction

function! ddu#ui#filer#multi_actions(actions) abort
  return ddu#ui#multi_actions(a:actions)
endfunction

function! ddu#ui#filer#_update_buffer(
      \ params, bufnr, lines, refreshed, pos) abort
  call setbufvar(a:bufnr, '&modifiable', 1)

  call setbufline(a:bufnr, 1, a:lines)
  silent call deletebufline(a:bufnr, len(a:lines) + 1, '$')

  call setbufvar(a:bufnr, '&modifiable', 0)
  call setbufvar(a:bufnr, '&modified', 0)

  if a:refreshed
    " Init the cursor
    call win_execute(bufwinid(a:bufnr),
          \ printf('call cursor(%d, 0) | redraw', a:pos + 1))
  endif
endfunction

function! ddu#ui#filer#_highlight_items(
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
    " Note: :redraw is needed for Vim
    redraw
  endif
endfunction
function! ddu#ui#filer#_highlight(
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

function! ddu#ui#filer#_save_cursor(path) abort
  if a:path ==# ''
    return
  endif

  let b:ddu_ui_filer_cursor_pos = getcurpos()
  let b:ddu_ui_filer_cursor_text = '.'->getline()

  " NOTE: Prevent saving after quitted
  if b:ddu_ui_filer_cursor_text ==# ''
    return
  endif

  if !exists('b:ddu_ui_filer_save_cursor')
    let b:ddu_ui_filer_save_cursor = {}
  endif
  let b:ddu_ui_filer_save_cursor[a:path] = #{
        \   pos: b:ddu_ui_filer_cursor_pos,
        \   text: b:ddu_ui_filer_cursor_text,
        \ }
endfunction
function! ddu#ui#filer#_restore_cursor(path) abort
  const save_pos = b:->get('ddu_ui_filer_save_cursor', {})
  if save_pos->has_key(a:path)
    const save_cursor_pos = save_pos[a:path].pos
    const save_cursor_text = save_pos[a:path].text
  else
    const save_cursor_pos = b:->get('ddu_ui_filer_cursor_pos', [])
    const save_cursor_text = b:->get('ddu_ui_filer_cursor_text', '')
  endif

  if !(save_cursor_pos->empty())
        \ && save_cursor_pos[1]->getline() ==# save_cursor_text
    call cursor(save_cursor_pos[1], save_cursor_pos[2])
  else
    call cursor(1, 1)
  endif
endfunction

function! ddu#ui#filer#_open_preview_window(params, bufnr, prev_winid) abort
  let preview_width = a:params.previewWidth
  let preview_height = a:params.previewHeight
  const winnr = a:bufnr->bufwinid()
  const pos = winnr->win_screenpos()
  const win_width = winnr->winwidth()
  const win_height = winnr->winheight()

  if a:params.previewSplit ==# 'vertical'
    if a:params.previewFloating && '*nvim_win_set_config'->exists()
      const buf = nvim_create_buf(v:true, v:false)

      if a:params.split ==# 'floating'
        let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
        let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1
        let preview_height = win_height
      else
        let win_row = pos[0] - 1
        let win_col = pos[1] - 1
      endif
      let win_col += win_width
      if (win_col + preview_width) > &columns
        let win_col -= preview_width
      endif

      call nvim_open_win(buf, v:true, #{
            \   relative: 'editor',
            \   row: win_row,
            \   col: win_col,
            \   width: preview_width,
            \   height: preview_height,
            \   border: a:params.previewFloatingBorder,
            \   zindex: a:params.previewFloatingZindex,
            \ })
    else
      silent rightbelow vnew
      execute 'vert resize ' .. preview_width
    endif
  elseif a:params.previewSplit ==# 'horizontal'
    if a:params.previewFloating && '*nvim_win_set_config'->exists()
      const buf = nvim_create_buf(v:true, v:false)

      if a:params.split ==# 'floating'
        let preview_width = win_width
      endif

      let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
      let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1
      if a:params.previewRow <= 0 && win_row <= preview_height
        let win_row += win_height + 1
        const anchor = 'NW'
      else
        const anchor = 'SW'
      endif

      call nvim_open_win(buf, v:true, #{
            \   relative: 'editor',
            \   anchor: anchor,
            \   row: win_row,
            \   col: win_col,
            \   width: preview_width,
            \   height: preview_height,
            \   border: a:params.previewFloatingBorder,
            \   zindex: a:params.previewFloatingZindex,
            \ })
    else
      silent aboveleft new
      execute 'resize ' .. preview_height
    endif
  elseif a:params.previewSplit ==# 'no'
    call win_gotoid(a:prev_winid)
  endif
endfunction
