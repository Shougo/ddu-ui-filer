# ddu-ui-filer

File listing UI for ddu.vim

Note: I have created
[Japanese article](https://zenn.dev/shougo/articles/ddu-ui-filer) for
ddu-ui-filer.

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddu.vim

https://github.com/Shougo/ddu.vim

## Configuration

```vim
call ddu#custom#patch_global({
    \   'ui': 'filer',
    \   'actionOptions': {
    \     'narrow': {
    \       'quit': v:false,
    \     },
    \   },
    \ })
```
