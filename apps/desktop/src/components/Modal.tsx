import type { ReactNode } from "react";
import { CloseIcon } from "./icons";
import "./Modal.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/** Small centered dialog shell (backdrop + frame) shared by the app's modals. */
export function Modal({ title, onClose, children, footer, width }: ModalProps) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button className="icon-btn modal__close" onClick={onClose} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
