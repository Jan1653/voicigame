#!/bin/sh
# Removes the Voicigame line from override.cfg next to the game. Everything else in the file stays.
# Run in a terminal in the game folder:   sh uninstall-linux.sh
cd "$(dirname "$0")" || exit 1

if [ ! -f override.cfg ] || ! grep -qi '^Voicigame=' override.cfg; then
	echo "Voicigame is not installed in this folder."
	exit 0
fi
if [ ! -w . ]; then
	echo "This folder is write protected. Run:  sudo sh uninstall-linux.sh"
	exit 1
fi
grep -vi '^Voicigame=' override.cfg > override.cfg.tmp || true
mv override.cfg.tmp override.cfg
# Only section headers and empty lines left: leave an empty file (the game ignores it)
grep -vqE '^\[.*\]$|^ *$' override.cfg || : > override.cfg

echo "Voicigame is removed. The game starts without it from now on."
echo 'You can delete the "voicigame" folder and the install files.'
