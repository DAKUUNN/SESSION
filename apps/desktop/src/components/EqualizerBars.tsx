import "./EqualizerBars.css";

/** Small animated "now playing" indicator — three bars pulsing at different
 *  offsets, the streaming-platform shorthand for "this is the one playing". */
export function EqualizerBars() {
  return (
    <span className="equalizer-bars" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
