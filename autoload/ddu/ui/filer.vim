let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-filer') : 0

function! ddu#ui#filer#do_action(name, ...) abort
  if !exists('b:ddu_ui_name')
    return
  endif

  let b:ddu_ui_filer_cursor_pos = getcurpos()
  let b:ddu_ui_filer_cursor_text = getline('.')

  call ddu#ui_action(b:ddu_ui_name, a:name, get(a:000, 0, {}))
endfunction

function! ddu#ui#filer#get_item() abort
  if !exists('b:ddu_ui_name')
    return {}
  endif

  call ddu#ui_action(b:ddu_ui_name, 'getItem', {})
  return get(b:, 'ddu_ui_filer_item', {})
endfunction
function! ddu#ui#filer#is_directory() abort
  let action = get(ddu#ui#filer#get_item(), 'action', {})
  return get(action, 'isDirectory', v:false)
endfunction

function! ddu#ui#filer#_update_buffer(
      \ params, bufnr, selected_items, highlight_items, lines, refreshed, pos) abort
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

  " Clear all highlights
  if has('nvim')
    call nvim_buf_clear_namespace(0, s:namespace, 0, -1)
  else
    call prop_clear(1, len(a:lines) + 1, { 'bufnr': a:bufnr })
  endif

  " Highlights items
  for item in a:highlight_items
    for hl in item.highlights
      call ddu#ui#filer#_highlight(
            \ hl.hl_group, hl.name, 1,
            \ s:namespace, a:bufnr,
            \ item.row, hl.col + strwidth(item.prefix), hl.width)
    endfor
  endfor

  " Selected items highlights
  for item_nr in a:selected_items
    call ddu#ui#filer#_highlight(
          \ 'Statement', 'ddu-ui-selected', 10000,
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
    if empty(prop_type_get(a:prop_type))
      call prop_type_add(a:prop_type, {
            \ 'highlight': a:highlight,
            \ 'priority': a:priority,
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
    call prop_add(a:row, a:col, {
          \ 'length': a:length,
          \ 'type': a:prop_type,
          \ 'bufnr': a:bufnr,
          \ 'id': a:id,
          \ })
  endif
endfunction
