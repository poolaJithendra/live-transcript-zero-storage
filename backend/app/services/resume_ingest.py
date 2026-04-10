from __future__ import annotations

from io import BytesIO
import re
from zipfile import ZipFile

from defusedxml import ElementTree
from pypdf import PdfReader


WORD_DOCUMENT_MIME_TYPES = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
}


def clean_resume_text(text: str) -> str:
    text = text.replace('\r', '\n')
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    return text.strip()


def extract_pdf_text(file_bytes: bytes) -> str:
    # Prefer strict parsing to avoid expensive recovery paths on malformed PDFs.
    reader = PdfReader(BytesIO(file_bytes), strict=True)
    pages = [page.extract_text() or '' for page in reader.pages]
    return clean_resume_text('\n'.join(pages))


def extract_docx_text(file_bytes: bytes) -> str:
    with ZipFile(BytesIO(file_bytes)) as archive:
        xml_content = archive.read('word/document.xml')

    root = ElementTree.fromstring(xml_content)
    paragraphs: list[str] = []
    namespace = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

    for paragraph in root.findall('.//w:p', namespace):
        parts = [node.text or '' for node in paragraph.findall('.//w:t', namespace)]
        text = ''.join(parts).strip()
        if text:
            paragraphs.append(text)

    return clean_resume_text('\n'.join(paragraphs))


def extract_resume_text(file_name: str, content_type: str | None, file_bytes: bytes) -> str:
    normalized_name = file_name.lower()
    normalized_type = (content_type or '').lower()

    if normalized_name.endswith('.pdf') or normalized_type == 'application/pdf':
        return extract_pdf_text(file_bytes)

    if normalized_name.endswith('.docx') or normalized_type in WORD_DOCUMENT_MIME_TYPES:
        return extract_docx_text(file_bytes)

    if normalized_name.endswith('.doc'):
        raise ValueError('Legacy .doc files are not supported yet. Please upload a PDF or .docx file.')

    raise ValueError('Unsupported file type. Upload a PDF or .docx resume.')
