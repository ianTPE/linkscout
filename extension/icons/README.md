# LinkScout logo

The linked shapes represent web links; the mint northeast point represents scouting for useful results before opening them.

- `logo.svg`: editable vector master, with a navy tile.
- `logo-mark.svg`: transparent mark for use on dark backgrounds.
- `logo-lockup.svg`: horizontal logo with the LinkScout name.
- `icon-{16,32,48,128}.png`: browser extension icons.
- `logo-512.png`: large raster export.

Colors: navy `#142D42`, mint `#68E0BD`, white `#F4FAFC`.

PNG files are rendered from `logo.svg` using librsvg at 1024 px, then downsampled with ImageMagick. To regenerate with the librsvg CLI (`rsvg-convert`) and ImageMagick installed:

```sh
rsvg-convert -w 1024 -h 1024 extension/icons/logo.svg -o /tmp/linkscout-logo-master.png
for size in 16 32 48 128; do
  convert /tmp/linkscout-logo-master.png -resize "${size}x${size}" "extension/icons/icon-${size}.png"
done
convert /tmp/linkscout-logo-master.png -resize 512x512 extension/icons/logo-512.png
```
