import * as exifr from 'exifr';

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function readPhotoMetadata(filePath) {
  const data = await exifr.parse(filePath, {
    gps: true,
    tiff: true,
    exif: true,
    ifd0: true,
    pick: [
      'DateTimeOriginal', 'CreateDate', 'ModifyDate',
      'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude',
      'Orientation', 'Make', 'Model'
    ]
  }).catch(() => null);

  if (!data) return { capturedAt: null, latitude: null, longitude: null, orientation: null, make: null, model: null };

  const capturedAt = parseDate(data.DateTimeOriginal) || parseDate(data.CreateDate) || parseDate(data.ModifyDate);
  const latitude = Number.isFinite(data.latitude) ? data.latitude : null;
  const longitude = Number.isFinite(data.longitude) ? data.longitude : null;

  return {
    capturedAt,
    latitude,
    longitude,
    orientation: data.Orientation ?? null,
    make: data.Make ?? null,
    model: data.Model ?? null
  };
}
