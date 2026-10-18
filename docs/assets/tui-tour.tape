# A short tour of `reflex tui` on synthetic history (packages/test-fixtures), never real sessions.
# Run from the repository root after `pnpm build`:  vhs docs/assets/tui-tour.tape
# Also writes a still of each view to docs/assets/tui-*.png.

Output docs/assets/tui-tour.gif

Set Shell bash
Set FontSize 14
Set Width 1400
Set Height 860
Set Padding 16
Set WindowBar Colorful

Hide
Type "source docs/assets/demo-env.sh && reflex scan --days 30 --yes > /dev/null && clear"
Enter
Sleep 30s
Type "reflex"
Enter
Sleep 3s
Show

Sleep 3s
Screenshot docs/assets/tui-dashboard.png
Sleep 1s
Type "2"
Sleep 3s
Screenshot docs/assets/tui-tokens.png
Sleep 1s
Type "3"
Sleep 3s
Screenshot docs/assets/tui-skills.png
Sleep 1s
Type "4"
Sleep 3s
Screenshot docs/assets/tui-workflows.png
Sleep 1s
Type "5"
Sleep 3s
Screenshot docs/assets/tui-router.png
Sleep 1s
Type "6"
Sleep 3s
Screenshot docs/assets/tui-search.png
Sleep 1s
Type "0"
Sleep 2s

Hide
Type "q"
Sleep 1s
