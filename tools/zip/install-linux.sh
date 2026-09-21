#!/bin/sh
# Installs the Voicigame mod on Linux: extract the whole ZIP into the game folder (next to the game's executable),
# then run in a terminal in that folder:   sh install-linux.sh
# It adds one line to override.cfg next to the game, the game files stay unchanged.
cd "$(dirname "$0")" || exit 1
DIR=$(pwd)

if [ ! -f voicigame/main.gd ]; then
	echo 'The folder "voicigame" is missing. Extract the whole ZIP into the game folder.'
	exit 1
fi
if ! ls | grep -i 'choicer' | grep -qv '\.gd$'; then
	echo "No The Choicer Voicer game file found here."
	echo "Extract the ZIP into the folder that contains the game, then run this again."
	exit 1
fi
if [ ! -w . ]; then
	echo "This folder is write protected. Run:  sudo sh install-linux.sh"
	exit 1
fi

# Remove an older Voicigame entry (for example from another folder), keep everything else
if [ -f override.cfg ]; then
	grep -vi '^Voicigame=' override.cfg > override.cfg.tmp || true
	mv override.cfg.tmp override.cfg
	# Only section headers and empty lines left: start the file fresh
	grep -vqE '^\[.*\]$|^ *$' override.cfg || : > override.cfg
fi

# Last section already [autoload]? Then only add the line, otherwise a new [autoload] section
LAST=$(grep -E '^\[.*\]$' override.cfg 2>/dev/null | tail -n 1)
if [ "$LAST" != "[autoload]" ]; then
	printf '\n[autoload]\n\n' >> override.cfg
fi
printf 'Voicigame="*%s/voicigame/main.gd"\n' "$DIR" >> override.cfg

echo "Voicigame is installed."
echo "Start the game, then Play and the Voicigame tile."
