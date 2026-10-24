; MailHub 自定义卸载/升级文件清理逻辑
;
; electron-builder 默认会在升级时把整个 $INSTDIR 递归移走再删除，
; 而我们的账号、邮件缓存、正文都存在 "$INSTDIR\data" 下，
; 直接走默认逻辑会导致“一路升级、数据全丢”。
;
; 这里接管删除行为：
;   - 升级（${isUpdated}）：只删应用文件和运行时目录，保留 data\
;   - 卸载：整目录删除（含 data），卸载前请自行备份需要保留的邮件

!macro customRemoveFiles
  SetOutPath $TEMP

  ${if} ${isUpdated}
    ; 应用运行时目录，整体删除
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"

    ; Electron 运行时文件（按类型清，避免误删 data 目录里的内容）
    Delete "$INSTDIR\*.exe"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\*.html"
    Delete "$INSTDIR\*.txt"
    Delete "$INSTDIR\*.ico"
    Delete "$INSTDIR\*.node"
    Delete "$INSTDIR\*.log"
    Delete "$INSTDIR\LICENSE*"
    Delete "$INSTDIR\version"
    Delete "$INSTDIR\*.bak"
    Delete "$INSTDIR\*.old"
  ${else}
    ; 真正卸载：连同 data 目录一起清掉
    RMDir /r "$INSTDIR"
  ${endif}
!macroend