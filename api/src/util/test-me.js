import { fetch, Agent } from 'undici';

const apiUrl = `http://localhost:9000/`;

export default async function testMe(req, res) {
  let reqUrl = req.body.url ? req.body.url : "https://www.youtube.com/watch?v=snYu2JUqSWs";
  try {
    const response = await fetch(apiUrl, {
      dispatcher: new Agent(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Api-Key 47f163d4-0ee4-4eff-9a03-1dd740d85743',
      },
      body: JSON.stringify({
        url: reqUrl,
        audioFormat: 'mp3',
        downloadMode: "audio",
        audioBitrate: "320",
        videoQuality: "144"
      }),
    });
    if (!response.ok) {
      return res.status(500).json({ status: 'false', msg: 'cobalt error' });
    }

    const data = await response.json();
    const downloadUrl = data.url;

    const downloadResponse = await fetch(downloadUrl, {
      dispatcher: new Agent(),
    });
    const buffer = await downloadResponse.arrayBuffer();

    if (buffer.byteLength > 0) {
      return res.status(200).json({ status: 'true', msg: 'successfull'});
    } else {
      return res.status(500).json({ status: 'false', msg: 'download size is zero' });
    }
  } catch (error) {
    console.log(`Error getting download size ${apiUrl}: ${error.message}`);
    return res.status(500).json({ status: 'false', msg: 'cannot send req to cobalt' });
  }
}

