#!/data/data/com.termux/files/usr/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    echo "Usage: ./install-termux.sh /path/to/SillyTavern"
    exit 2
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
st_dir=$(CDPATH= cd -- "$1" && pwd)
extension_link="$st_dir/public/scripts/extensions/third-party/Continuity-Memory"
plugin_link="$st_dir/plugins/continuity-memory"

if [ -e "$extension_link" ] || [ -L "$extension_link" ] || [ -e "$plugin_link" ] || [ -L "$plugin_link" ]; then
    echo "Continuity install paths already exist. Remove the old install deliberately before rerunning."
    exit 1
fi

ln -s "$project_dir/extension" "$extension_link"
ln -s "$project_dir/plugin" "$plugin_link"
echo "Continuity Memory linked successfully. Restart SillyTavern and reload the browser page."
