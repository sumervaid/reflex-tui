# A short tour of `reflex tui` on synthetic history (packages/test-fixtures), never real sessions.
# Run from the repository root after `pnpm build`:  vhs docs/assets/tui-tour.tape
# The layout is designed for 150x45 terminal cells; adjust Width/Height if the frame is cut off.

Output docs/assets/tui-tour.gif

Set Shell bash
Set FontSize 14
Set Width 1440
Set Height 900
Set Padding 10

Hide
Type "source docs/assets/demo-env.sh && reflex scan --days 30 --yes > /dev/null && clear"
Enter
Sleep 30s
Show

Type "reflex"
Enter
Sleep 3s

# Dashboard, Tokens, Skills, Workflows, Router, Search
Type "2"
Sleep 3s
Type "3"
Sleep 3s
Type "j"
Sleep 2s
Type "4"
Sleep 3s
Type "5"
Sleep 3s
Type "6"
Sleep 3s
Type "0"
Sleep 2s
Type "q"
Sleep 1s
