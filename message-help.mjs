const labels = {
  H1: 'Aircraft system message. Its sublabel can identify the onboard system or application.',
  B6: 'ADS-C report. The encoded data can include position, altitude and movement.',
  QQ: 'Departure report. It tells the ground system that the aircraft has departed.',
  Q0: 'Link test or acknowledgement through the ACARS system.',
  SA: 'Media advisory about the aircraft’s data link.',
  VDL2: 'VHF Data Link Mode 2 frame. The current decoder reported the frame size.',
};

const airports = {
  YSSY:'Sydney Kingsford Smith', YSWS:'Western Sydney', YSBK:'Bankstown', YSCB:'Canberra',
  YMML:'Melbourne', YBBN:'Brisbane', YPPH:'Perth', YPAD:'Adelaide', OTHH:'Doha Hamad',
};
const airportCodes = Object.keys(airports).join('|');
const routePattern = new RegExp(`(${airportCodes})(${airportCodes})`);

export function explainMessage(message) {
  const label = (message.rawLabel ?? message.tag ?? '').toUpperCase();
  const text = (message.detail ?? '').toUpperCase();
  const fields = [];
  const flight = /^[A-Z]\d{2}[A-Z]([A-Z0-9]{2}\d{3}[A-Z0-9])(?=[.,/#\-\s]|[A-Z]{8}|$)/.exec(text)?.[1];
  if (flight) fields.push(`Flight identifier in the message ${flight}.`);
  const route = routePattern.exec(text);
  if (route) fields.push(`Airport pair ${route[1]} and ${route[2]} means ${airports[route[1]]} and ${airports[route[2]]}.`);
  const coordinates = /(?:^|,)\s*([NS])\s*(\d{1,2}\.\d{2,})\s*,\s*([EW])\s*(\d{1,3}\.\d{2,})(?=,|\s|$)/.exec(text);
  if (coordinates && Number(coordinates[2])<=90 && Number(coordinates[4])<=180) {
    const [,ns,latitude,ew,longitude] = coordinates;
    fields.push(`Position ${latitude}° ${ns}, ${longitude}° ${ew}.`);
  }
  if (label==='H1' && /#DF[A-Z]/.test(text)) {
    fields.push('The DF sublabel identifies the digital flight data acquisition unit. Following fields use the aircraft’s report format.');
  }
  if (/\.ADS\.[A-Z0-9-]{3,9}/.test(text)) {
    fields.push('The .ADS. marker identifies an ADS-C application message carried on the data link.');
  }
  const summary = label==='16' && coordinates && flight?.startsWith('QR') ? 'Qatar Airways position report.' :
    labels[label] ?? `Message label ${label || 'unknown'}. Its application is unconfirmed for this payload.`;
  return {summary,fields};
}
