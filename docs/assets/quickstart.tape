# scan → suggest → approve → install on synthetic history (packages/test-fixtures), never real sessions.
# Run from the repository root after `pnpm build`:  vhs docs/assets/quickstart.tape

Output docs/assets/quickstart.gif

Set Shell bash
Set FontSize 16
Set Width 1500
Set Height 860
Set TypingSpeed 45ms
Set Padding 24
Set Margin 24
Set MarginFill "#5b4bd6"
Set WindowBar Colorful
Set BorderRadius 10

Hide
Type "source docs/assets/demo-env.sh && clear"
Enter
Sleep 20s
Show

Sleep 500ms
Type "reflex scan --days 30 --yes"
Sleep 300ms
Enter
Sleep 5s

Type "clear && reflex suggest --no-interactive | head -26"
Sleep 300ms
Enter
Sleep 7s

Type "clear && reflex approve fix-ci --yes --no-install | sed -n '25,48p'"
Sleep 300ms
Enter
Sleep 7s

Type "clear && reflex install fix-ci --target claude-code --yes"
Sleep 300ms
Enter
Sleep 5s
