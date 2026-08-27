from pathlib import Path
from typing import List

# pip install beautifulsoup4 (only needed the first time)
from bs4 import BeautifulSoup

def get_links(folder_name: str = "Airbus Applying") -> List[str]:
    """
    Return every link (<A HREF=…>) that sits inside one specific bookmark folder.

    Parameters
    ----------
    bookmarks_file : Path
        The full path to the HTML bookmarks export (e.g. Path("input/bookmarks_10_16_25.html")).
    folder_name : str, optional
        The exact name of the folder you want to scan.  Default is "Airbus Applying".

    Raises
    ------
    ValueError
        If the folder is not present in the file.
    """
    l = []
    input_dir = Path("input")
    files = list(input_dir.glob("bookmarks*"))
    if not files:
        raise FileNotFoundError("No bookmarks files starting with 'bookmarks' found in 'input/'")
    latest_file = max(files, key=lambda p: p.stat().st_mtime)
    # f = latest_file.open("r", encoding="utf-8")
    # lines = f.readlines()
    html = latest_file.read_text(encoding="utf-8", errors="ignore")
    soup = BeautifulSoup(html, "html.parser")

    # Find the <H3> whose visible text matches the folder we want
    h3 = soup.find("h3", string=lambda s: s and s.strip() == folder_name)
    if not h3:
        raise ValueError(f"Folder “{folder_name}” not found in bookmarks file {latest_file}")

    # The <DL> immediately after that <H3> encloses the folder’s contents
    dl = h3.find_next("dl")
    links = [a["href"] for a in dl.find_all("a", href=True)]

    return links

if __name__ == "__main__":
    # get_links takes a bookmark *folder name*; the newest input/bookmarks*.html
    # is picked automatically.
    links = get_links()
    print(f"Found {len(links)} links:")
    for url in links:
        print(url)
