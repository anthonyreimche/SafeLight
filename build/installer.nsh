; Safelight installer look: the landing site's print style. Paper and ink,
; Afacad, solid ink rules, a red progress bar in an ink frame, and the hero's
; cards on the welcome and finish pages. See
; docs/superpowers/specs/2026-10-05-installer-and-download-page-design.md.
;
; electron-builder prepends this file (nsis.include) to its NSIS template and
; compiles the result twice: with BUILD_UNINSTALLER to make the uninstaller,
; then without for the installer. Warnings are errors there, so a function
; may only exist in the pass that calls it; SL_UN names the shared ones "un."
; in the uninstaller pass.

ManifestDPIAware true
!include LogicLib.nsh
!include WinMessages.nsh

!ifdef BUILD_UNINSTALLER
  !define SL_UN "un."
!else
  !define SL_UN ""
!endif

!define SL_PAPER "F3ECE0"
!define SL_CARD "FBF8F2"
!define SL_INK "16110F"
!define SL_MUTED "5C514B"
; the progress bar messages take COLORREFs, 0x00BBGGRR
!define SL_RED_REF 0x2F17E5
!define SL_CARD_REF 0xF2F8FB
!define SL_ART "${BUILD_RESOURCES_DIR}\installer"
!define SL_FONTS "${BUILD_RESOURCES_DIR}\installer-font"

!define MUI_BGCOLOR "${SL_PAPER}"
!define MUI_TEXTCOLOR "${SL_INK}"
!define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.slGuiInit
  ; the uninstaller keeps MUI's own translated titles, which run to two lines
  !define SL_TITLE_SIZE 140
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT slGuiInit
  !define SL_TITLE_SIZE 220
!endif

Var slDpi
Var slAfacad
Var slBody
Var slStrong
Var slTitle
Var slEdgeTop
Var slEdgeBottom
Var slEdgeLeft
Var slEdgeRight
!ifndef BUILD_UNINSTALLER
  Var slStyledPage
!endif

; Afacad only where it covers every character of the installer's texts: the
; LCIDs of electron-builder's installer languages that passed that check
; (spec § Font). The others keep the Windows font.
!macro slPickFont
  ${Switch} $LANGUAGE
    ${Case} 1033
    ${Case} 1031
    ${Case} 1036
    ${Case} 3082
    ${Case} 1040
    ${Case} 1043
    ${Case} 1030
    ${Case} 1053
    ${Case} 1044
    ${Case} 1035
    ${Case} 2070
    ${Case} 1046
    ${Case} 1045
    ${Case} 1029
    ${Case} 1051
    ${Case} 1038
    ${Case} 1055
    ${Case} 1066
      StrCpy $slAfacad 1
      ${Break}
    ${Default}
      StrCpy $slAfacad 0
  ${EndSwitch}
!macroend

; MUI has extracted the 100 % sidebar and header by now; these overwrite them
; with the art drawn for the display's scaling, shown pixel for pixel.
!macro slArtFor SCALE
  File "/oname=$PLUGINSDIR\modern-wizard.bmp" "${SL_ART}\sidebar-${SCALE}.bmp"
  File "/oname=$PLUGINSDIR\sl-header.bmp" "${SL_ART}\header-${SCALE}.bmp"
!macroend

; Afacad Setup at SIZE tenths of a point and WEIGHT, for the display's dpi.
!macro slFont VAR SIZE WEIGHT
  IntOp $0 ${SIZE} * $slDpi
  IntOp $0 $0 / 720
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFont(i r0, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, t "Afacad Setup") p.s'
  Pop ${VAR}
!macroend

; Window HWND's rect in PARENT's client coordinates: $2 left, $3 top,
; $4 width, $5 height ($1 is scratch).
!macro slRectIn PARENT HWND
  System::Call '*(i,i,i,i) p.r1'
  System::Call 'user32::GetWindowRect(p ${HWND}, p r1)'
  System::Call 'user32::MapWindowPoints(p 0, p ${PARENT}, p r1, i 2)'
  System::Call '*$1(i.r2, i.r3, i.r4, i.r5)'
  System::Free $1
  IntOp $4 $4 - $2
  IntOp $5 $5 - $3
!macroend

; Two pixels at 96 dpi, in whole pixels at the display's: into $6.
!macro slRuleWidth
  IntOp $6 $slDpi * 2
  IntOp $6 $6 + 48
  IntOp $6 $6 / 96
!macroend

; An etched separator of the outer window becomes a solid ink rule across it.
!macro slInkRule ID
  GetDlgItem $0 $HWNDPARENT ${ID}
  System::Call 'user32::GetWindowLong(p r0, i -16) i.r1'
  IntOp $1 $1 & 0xFFFFEFE0
  System::Call 'user32::SetWindowLong(p r0, i -16, i r1)'
  System::Call 'user32::SetWindowLong(p r0, i -20, i 0)'
  SetCtlColors $0 "" "${SL_INK}"
  !insertmacro slRectIn $HWNDPARENT $0
  !insertmacro slRuleWidth
  System::Call '*(i,i,i,i) p.r7'
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r7)'
  System::Call '*$7(i, i, i.r8, i)'
  System::Free $7
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i r3, i r8, i r6, i 0x34)'
!macroend

!macro slEdge VAR
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x44000000, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0) p.s'
  Pop ${VAR}
  SetCtlColors ${VAR} "" "${SL_INK}"
!macroend

!macro slHideFrame
  ShowWindow $slEdgeTop ${SW_HIDE}
  ShowWindow $slEdgeBottom ${SW_HIDE}
  ShowWindow $slEdgeLeft ${SW_HIDE}
  ShowWindow $slEdgeRight ${SW_HIDE}
!macroend

!macro slPushRegisters
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
!macroend

!macro slPopRegisters
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

Function ${SL_UN}slGuiInit
  System::Call 'user32::GetDC(p 0) p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 90) i.r1'
  System::Call 'user32::ReleaseDC(p 0, p r0)'
  StrCpy $slDpi $1

  IntOp $0 $slDpi * 100
  IntOp $0 $0 / 96
  ${If} $0 >= 300
    !insertmacro slArtFor 300
  ${ElseIf} $0 >= 250
    !insertmacro slArtFor 250
  ${ElseIf} $0 >= 200
    !insertmacro slArtFor 200
  ${ElseIf} $0 >= 175
    !insertmacro slArtFor 175
  ${ElseIf} $0 >= 150
    !insertmacro slArtFor 150
  ${ElseIf} $0 >= 125
    !insertmacro slArtFor 125
  ${Else}
    !insertmacro slArtFor 100
  ${EndIf}

  !insertmacro slPickFont
  ${If} $slAfacad == 1
    File "/oname=$PLUGINSDIR\AfacadSetup-Regular.ttf" "${SL_FONTS}\AfacadSetup-Regular.ttf"
    File "/oname=$PLUGINSDIR\AfacadSetup-Bold.ttf" "${SL_FONTS}\AfacadSetup-Bold.ttf"
    System::Call 'gdi32::AddFontResourceEx(t "$PLUGINSDIR\AfacadSetup-Regular.ttf", i 0x10, p 0)'
    System::Call 'gdi32::AddFontResourceEx(t "$PLUGINSDIR\AfacadSetup-Bold.ttf", i 0x10, p 0)'
    !insertmacro slFont $slBody 105 400
    !insertmacro slFont $slStrong 120 700
    !insertmacro slFont $slTitle ${SL_TITLE_SIZE} 700
  ${EndIf}

  SetCtlColors $HWNDPARENT "${SL_INK}" "${SL_PAPER}"
  ${If} $slAfacad == 1
    ${ForEach} $1 1 3 + 1
      GetDlgItem $0 $HWNDPARENT $1
      SendMessage $0 ${WM_SETFONT} $slBody 1
    ${Next}
  ${EndIf}

  ; header: title, subtitle and the wordmark
  GetDlgItem $0 $HWNDPARENT 1037
  SetCtlColors $0 "${SL_INK}" "${SL_PAPER}"
  ${If} $slAfacad == 1
    SendMessage $0 ${WM_SETFONT} $slStrong 1
    ; Afacad Bold's descenders need more height than the control is given
    !insertmacro slRectIn $HWNDPARENT $0
    IntOp $5 $5 * 3
    IntOp $5 $5 / 2
    System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i r4, i r5, i 0x16)'
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1038
  SetCtlColors $0 "${SL_MUTED}" "${SL_PAPER}"
  ${If} $slAfacad == 1
    SendMessage $0 ${WM_SETFONT} $slBody 1
  ${EndIf}
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\sl-header.bmp", i 0, i 0, i 0, i 0x10) p.r1'
  GetDlgItem $0 $HWNDPARENT 1046
  SendMessage $0 ${STM_SETIMAGE} 0 $1

  ; separators: under the header, above the buttons on inner pages and on
  ; the welcome and finish pages
  !insertmacro slInkRule 1036
  !insertmacro slInkRule 1035
  !insertmacro slInkRule 1045

  ; The version moves into the button row, level with the buttons. NSIS
  ; draws an engraved second copy (1028) and shows it on every page, so that
  ; one moves out of sight.
  GetDlgItem $0 $HWNDPARENT 3
  !insertmacro slRectIn $HWNDPARENT $0
  IntOp $6 $slDpi * 24
  IntOp $6 $6 / 96
  IntOp $7 $2 - $6
  IntOp $7 $7 - $6
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 "${SL_MUTED}" "${SL_PAPER}"
  ${If} $slAfacad == 1
    SendMessage $0 ${WM_SETFONT} $slBody 1
  ${EndIf}
  System::Call 'user32::GetWindowLong(p r0, i -16) i.r1'
  IntOp $1 $1 | 0x200 ; SS_CENTERIMAGE: centred vertically
  System::Call 'user32::SetWindowLong(p r0, i -16, i r1)'
  System::Call 'user32::SetWindowPos(p r0, p 0, i r6, i r3, i r7, i r5, i 0x34)'
  GetDlgItem $0 $HWNDPARENT 1028
  System::Call 'user32::SetWindowPos(p r0, p 0, i -10000, i 0, i 0, i 0, i 0x15)'

  ; The progress frame's edges, made here because the uninstaller styles its
  ; progress page from the uninstall thread, which must not create windows.
  !insertmacro slEdge $slEdgeTop
  !insertmacro slEdge $slEdgeBottom
  !insertmacro slEdge $slEdgeLeft
  !insertmacro slEdge $slEdgeRight
FunctionEnd

; Paper and ink on the page window on the stack and on each of its controls,
; the card colour on edit fields, and Afacad where the language has it.
Function ${SL_UN}slStylePage
  Exch $R0
  Push $R1
  Push $R2
  SetCtlColors $R0 "${SL_INK}" "${SL_PAPER}"
  StrCpy $R1 0
  ${Do}
    FindWindow $R1 "" "" $R0 $R1
    ${IfThen} $R1 == 0 ${|} ${Break} ${|}
    ${If} $slAfacad == 1
      SendMessage $R1 ${WM_SETFONT} $slBody 1
    ${EndIf}
    System::Call 'user32::GetClassName(p R1, t .R2, i 64)'
    ${If} $R2 == "Edit"
      SetCtlColors $R1 "${SL_INK}" "${SL_CARD}"
    ${ElseIf} $R2 != "msctls_progress32"
      SetCtlColors $R1 "${SL_INK}" "${SL_PAPER}"
    ${EndIf}
  ${Loop}
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; Every page window the outer window holds: normally one, but a built-in
; page (the progress page) is still there while the custom page after it
; (finish) is set up.
Function ${SL_UN}slPageShow
  Push $R0
  StrCpy $R0 0
  ${Do}
    FindWindow $R0 "#32770" "" $HWNDPARENT $R0
    ${IfThen} $R0 == 0 ${|} ${Break} ${|}
    Push $R0
    Call ${SL_UN}slStylePage
  ${Loop}
  Pop $R0
FunctionEnd

; Welcome and finish. Their MUI variables are declared only once the page is
; inserted, after customUninstallPage, so the title is found by its id: MUI
; creates the image (1200) first and the title (1201) second.
Function ${SL_UN}slFullPageShow
  Push $R0
  Push $R1
  Call ${SL_UN}slPageShow
  ${If} $slAfacad == 1
    StrCpy $R0 0
    ${Do}
      FindWindow $R0 "#32770" "" $HWNDPARENT $R0
      ${IfThen} $R0 == 0 ${|} ${Break} ${|}
      GetDlgItem $R1 $R0 1201
      ${IfThen} $R1 != 0 ${|} SendMessage $R1 ${WM_SETFONT} $slTitle 1 ${|}
    ${Loop}
  ${EndIf}
  !insertmacro slHideFrame
  Pop $R1
  Pop $R0
FunctionEnd

; The bar is drawn flat, red on the card colour, and shrinks into an ink
; frame that takes its old place. In the uninstaller this runs on the
; uninstall thread once the page is up, so it only sends messages to
; existing windows, and the edges are shown last so nothing paints over them.
Function ${SL_UN}slProgressShow
  !insertmacro slPushRegisters
  Call ${SL_UN}slPageShow
  StrCpy $R0 0
  ${Do}
    FindWindow $R0 "#32770" "" $HWNDPARENT $R0
    ${IfThen} $R0 == 0 ${|} ${Break} ${|}
    GetDlgItem $R1 $R0 1004
    ${IfThen} $R1 != 0 ${|} ${Break} ${|}
  ${Loop}
  ${If} $R0 != 0
    System::Call 'uxtheme::SetWindowTheme(p R1, w " ", w " ")'
    SendMessage $R1 ${PBM_SETBARCOLOR} 0 ${SL_RED_REF}
    SendMessage $R1 ${PBM_SETBKCOLOR} 0 ${SL_CARD_REF}
    ; the page window must not paint over the edges
    System::Call 'user32::GetWindowLong(p R0, i -16) i.r9'
    IntOp $9 $9 | 0x04000000
    System::Call 'user32::SetWindowLong(p R0, i -16, i r9)'

    !insertmacro slRuleWidth
    StrCpy $9 $6
    !insertmacro slRectIn $R0 $R1
    IntOp $2 $2 + $9
    IntOp $3 $3 + $9
    IntOp $6 $9 * 2
    IntOp $4 $4 - $6
    IntOp $5 $5 - $6
    System::Call 'user32::SetWindowPos(p R1, p 0, i r2, i r3, i r4, i r5, i 0x14)'

    ; the frame, in the outer window's coordinates, around the shrunk bar
    !insertmacro slRectIn $HWNDPARENT $R1
    IntOp $2 $2 - $9
    IntOp $3 $3 - $9
    IntOp $6 $9 * 2
    IntOp $4 $4 + $6
    IntOp $5 $5 + $6
    IntOp $7 $3 + $5
    IntOp $7 $7 - $9
    IntOp $8 $2 + $4
    IntOp $8 $8 - $9
    System::Call 'user32::SetWindowPos(p $slEdgeTop, p 0, i r2, i r3, i r4, i r9, i 0x50)'
    System::Call 'user32::SetWindowPos(p $slEdgeBottom, p 0, i r2, i r7, i r4, i r9, i 0x50)'
    System::Call 'user32::SetWindowPos(p $slEdgeLeft, p 0, i r2, i r3, i r9, i r5, i 0x50)'
    System::Call 'user32::SetWindowPos(p $slEdgeRight, p 0, i r8, i r3, i r9, i r5, i 0x50)'
  ${EndIf}
  !insertmacro slPopRegisters
FunctionEnd

!macro slUnloadFonts
  ${If} $slAfacad == 1
    System::Call 'gdi32::DeleteObject(p $slBody)'
    System::Call 'gdi32::DeleteObject(p $slStrong)'
    System::Call 'gdi32::DeleteObject(p $slTitle)'
    System::Call 'gdi32::RemoveFontResourceEx(t "$PLUGINSDIR\AfacadSetup-Regular.ttf", i 0x10, p 0)'
    System::Call 'gdi32::RemoveFontResourceEx(t "$PLUGINSDIR\AfacadSetup-Bold.ttf", i 0x10, p 0)'
  ${EndIf}
!macroend

; The fonts are released before NSIS deletes $PLUGINSDIR on exit.
!ifdef BUILD_UNINSTALLER
  Function un.onGUIEnd
    !insertmacro slUnloadFonts
  FunctionEnd
!else
  Function .onGUIEnd
    !insertmacro slUnloadFonts
  FunctionEnd

  ; The template gives the folder page no show hook. NSIS checks the folder
  ; as soon as the page opens, so that check styles each new page window.
  Function .onVerifyInstDir
    Push $0
    FindWindow $0 "#32770" "" $HWNDPARENT
    ${If} $0 != $slStyledPage
      StrCpy $slStyledPage $0
      Call slPageShow
    ${EndIf}
    Pop $0
  FunctionEnd
!endif

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Safelight"
  !define MUI_WELCOMEPAGE_TEXT "Build your own darkroom.$\r$\n$\r$\nThis installs Safelight ${VERSION} on this computer. Select Next to continue."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW slFullPageShow
  !insertmacro MUI_PAGE_WELCOME
  ; the template inserts the install-mode page next
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW slPageShow
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW slProgressShow
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "Open Safelight"
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_FINISHPAGE_TITLE "Safelight is ready"
  !define MUI_FINISHPAGE_TEXT "Your workspace, your rules."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW slFullPageShow
  !insertmacro MUI_PAGE_FINISH

  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
  !endif
!macroend

!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.slFullPageShow
  !insertmacro MUI_UNPAGE_WELCOME
  ; the template inserts the install-mode page next
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.slPageShow
!macroend

; The uninstall progress page has no show hook; the uninstall section starts
; as it opens.
!macro customUnInstall
  ${IfNot} ${Silent}
    Call un.slProgressShow
  ${EndIf}
!macroend

; Inserted just before the uninstaller's finish page.
!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.slFullPageShow
!macroend
