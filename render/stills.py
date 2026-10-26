"""Shared bounded still cache and low-resolution screen-change signatures."""
from functools import lru_cache

import cv2
import numpy as np


class StillCache:
    def __init__(self, directory, source):
        self.directory, self.source = directory, source
        self.decode_count = 0

    @lru_cache(maxsize=128)
    def load(self, name):
        image = cv2.imread(str(self.directory / name))
        if image is None:
            raise ValueError(f'Cannot decode still: {self.directory / name}')
        if (image.shape[1], image.shape[0]) != self.source:
            raise ValueError(f'Still has inconsistent dimensions: {name}')
        self.decode_count += 1
        return image

    @lru_cache(maxsize=256)
    def signature(self, name):
        image = cv2.resize(self.load(name), (160, 90), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        return cv2.GaussianBlur(gray, (3, 3), 0).astype(np.float32) / 255

    def difference(self, first, second):
        delta = np.abs(self.signature(first) - self.signature(second))
        mean, fraction = float(delta.mean()), float((delta > .08).mean())
        return dict(mean=mean, changed_fraction=fraction,
                    large=mean >= .018 and fraction >= .065)
