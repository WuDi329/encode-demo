import {
    max_video_config,
} from './resolution.js';
    let video = document.getElementById('src');
    let button = document.getElementById('record');
    let codec_el = document.getElementById('codec')
    let video_worker = null;
    let webmWorker = null;
    let stream = null;
    let videoTrack = null;
    let handle = null;

    const vp9_params = {
        profile: 0,
        level: 10,
        bit_depth: 8,
        // chroma_subsampling: chroma_el.value ? 2 : 1
    };
    const vp9c = Object.fromEntries(Object.entries(vp9_params).map(
        ([k, v]) => [k, v.toString().padStart(2, '0')]));
        //这里排除了chroma_subsampling
    // const vp9_codec = `vp09.${vp9c.profile}.${vp9c.level}.${vp9c.bit_depth}.${vp9c.chroma_subsampling}`;
    const vp9_codec = `vp09.${vp9c.profile}.${vp9c.level}.${vp9c.bit_depth}`;

    // See https://github.com/ietf-wg-cellar/matroska-specification/blob/master/codec/av1.md
    // and also https://aomediacodec.github.io/av1-isobmff/#codecsparam
    const av1_params = {
        profile: 0,
        level: 0,
        tier: 0,
        high_bitdepth: false,
        twelve_bit: false,
        monochrome: false,
        // chroma_subsampling_x: !!chroma_el.value,
        // chroma_subsampling_y: !!chroma_el.value,
        // chroma_sample_position: 0,
    };
    const av1_bitdepth = 8 + av1_params.high_bitdepth * (av1_params.profile === 2 && av1_params.twelve_bit ? 4 : 2)
    const av1_codec = `av01.${av1_params.profile}.${av1_params.level.toString().padStart(2, '0')}${av1_params.tier === 0 ? 'M' : 'H'}.${av1_bitdepth.toString().padStart(2, '0')}`;



    function relay_data(ev) {
        const msg = ev.data;
        switch (msg.type) {
            case 'error':
                onerror(msg.detail)
                break;

            case 'exit':
                if (++num_exits === 2) {
                    webmWorker.postMessage({ type: 'end' });
                }
                break;

            default:
                webmWorker.postMessage(msg, [msg.data]);
                break;
        }
    }

    function error(e) {
      console.error(e)
    }

    async function startRecording() {


      console.assert(button.innerText == 'Record');
      button.disabled = true;

      handle = await window.showSaveFilePicker({
          startIn: 'videos',
          suggestedName: 'myVideo.webm',
          types: [{
            description: 'Video File',
            accept: {'video/webm' :['.webm']}
            }],
      });

      //这里好像只采集了视频轨，没有音轨
      videoTrack = stream.getVideoTracks()[0];
      let video_settings = videoTrack.getSettings();
      let trackProcessor = new MediaStreamTrackProcessor(videoTrack);
      let frameStream = trackProcessor.readable;

      const codec = codec_el.options[codec_el.selectedIndex].value;
      console.log(codec);

      const encoder_constraints = {
        //codec: 'avc1.42E01E',
        codec: codec === 'av01' ? av1_codec : vp9_codec,
        width: video_settings.width,
        height: video_settings.height,
        bitrate: 2500 * 1000,
        framerate: video_settings.frameRate,
        latencyMode: 'realtime',
        /*avc: {
            format: 'annexb'
        }*/
    };
      // Encoder I/O and file writing happens in a Worker to keep the UI
      // responsive.
      video_worker = new Worker('./encoder-worker.js');
      webmWorker = new Worker('./webm-worker.js')
      
      video_worker.onmessage = relay_data;
      video_worker.onerror = error;

      webmWorker.onerror = error;

      webmWorker.onmessage = async ev => {
        const msg = ev.data;
        switch (msg.type) {
            case 'exit':
                if (msg.code !== 0) {
                    onerror(`muxer exited with status ${msg.code}`);
                }
                webmWorker.terminate();
                video_worker.terminate();
                // audio_worker.terminate();
                exited = true;

                if (record_el.checked) {
                    const r = await writer.finish();
                    rec_info.innerText = `Finished: Duration ${writer.duration}ms, Size ${writer.size} bytes`;
                    if (inmem_el.checked) {
                        const blob = new Blob(r, { type: 'video/webm' });
                        const a = document.createElement('a');
                        const filename = 'camera.webm';
                        a.textContent = filename;
                        a.href = URL.createObjectURL(blob);
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    } else {
                        rec_info.innerText += `, Filename ${writer.name}, Cues at ${r ? 'start' : 'end'}`;
                    }
                }

                start_el.disabled = false;
                record_el.disabled = false;
                pcm_el.disabled = !record_el.checked;
                inmem_el.disabled = !record_el.checked;

                break;

            case 'start-stream':
                video_worker.postMessage({
                    type: 'start',
                    readable: frameStream,
                    key_frame_interval,
                    config: video_encoder_config
                }, [frameStream]);

                // audio_worker.postMessage({
                //     type: 'start',
                //     audio: true,
                //     readable: audio_readable,
                //     config: {
                //         codec: pcm_el.checked ? 'pcm' : 'opus',
                //         bitrate: 128 * 1000,
                //         sampleRate: audio_settings.sampleRate,
                //         numberOfChannels: audio_settings.channelCount
                //     }
                // }, [audio_readable]);

                // stop_el.disabled = false;

                break;

            case 'muxed-data':
                if (record_el.checked) {
                    await writer.write(msg.data);
                    rec_info.innerText = `Recorded ${writer.size} bytes`;
                }
                queue.push(msg.data);
                if (!pcm_el.checked) {
                    remove_append();
                }
                break;

            case 'stats':
                console.log(msg.data);
                break;

            case 'error':
                onerror(msg.detail);
                break;
        }
    };


      const video_encoder_config = await max_video_config({
        ...encoder_constraints,
        ratio: video_settings.width / video_settings.height
    }) || await max_video_config(encoder_constraints);

    console.log(`video resolution: ${video_settings.width}x${video_settings.height}`);
    console.log(`encoder resolution: ${video_encoder_config.width}x${video_encoder_config.height}`);

      // Tell the worker to start encoding the frames and writing the file.
      // NOTE: transferring frameStream and reading it in the worker is more
      // efficient than reading frameStream here and transferring VideoFrames
      // individually. This allows us to entirely avoid processing frames on the
      // main (UI) thread.
    //   video_worker.postMessage({
    //     type: 'start',
    //     fileHandle: handle,
    //     frameStream: frameStream,
    //     video_settings: video_settings
    //   }, [frameStream]);

      button.innerText = 'Stop';
      button.disabled = false;
    }

    function stopRecording() {
      console.assert(button.innerText == 'Stop');
      button.innerText = 'Record';
      video_worker.postMessage({ type: 'stop'});
      return ;
    }

    function remove_append() {
        if (buffer.updating) {
            return;
        }
        if (exited) {
            if (video.src) {
                buffer.removeEventListener('updateend', remove_append);
                buf_info.innerText = '';
                source.endOfStream();
                video.pause();
                video.removeAttribute('src');
                video.currentTime = 0;
                video.poster = poster;
                video.load();
            }
            return;
        }
        const range = buffer.buffered;
        if (range.length > 0) {
            buf_info.innerText = `Buffered ${range.start(0)} .. ${range.end(0)}`;
        }
        if ((video.currentTime === 0) &&
            ((buffer_delay === 0) ||
             ((range.length > 0) && (range.end(0) > buffer_delay)))) {
            video.poster = '';
            video.play();
        }
        const check = video.currentTime - key_frame_interval * 2;
        if ((range.length > 0) && (range.start(0) < check)) {
            buffer.remove(0, check);
        } else if (queue.length > 0) {
            buffer.appendBuffer(queue.shift());
        }
    }

    // async function onButtonClicked() {
      
    // };

    button.addEventListener('click', async function() {
        switch(button.innerText) {
            case 'Record':
              startRecording();
              break;
            case 'Stop':
              stopRecording();
              break;
          }
    })

    async function main() {
      let constraints = {
        //这里目前不加audio
        audio: false,
        video: {width: 1280, height: 720, frameRate: {ideal: 30, max: 30}}
      };
      stream = await window.navigator.mediaDevices.getUserMedia(constraints);
    //   let video = document.getElementById('src');
      video.srcObject = stream;
    }
    document.body.onload = main;