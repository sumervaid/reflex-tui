# scan → suggest → approve → install on synthetic history (packages/test-fixtures), never real sessions.
# Run from the repository root after `pnpm build`:  vhs docs/assets/quickstart.tape

Output docs/assets/quickstart.gif

Set Shell bash
Set FontSize 16
Set Width 1200
Set Height 800
Set TypingSpeed 40ms
Set Padding 20

Hide
Type "source docs/assets/demo-env.sh && clear"
Enter
Sleep 20s
Show

Type "reflex scan --days 30 --yes"
Enter
Sleep 6s

Type "reflex suggest --no-interactive | head -32"
Enter
Sleep 6s

Type "reflex approve fix-ci --yes --no-install | tail -3"
Enter
Sleep 3s

Type "reflex install fix-ci --target claude-code --yes"
Enter
Sleep 4s
